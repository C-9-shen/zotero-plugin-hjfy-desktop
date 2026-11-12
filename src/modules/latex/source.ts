/** A conservative TeX scanner: translate prose, leave executable syntax intact. */
export interface LatexUnit {
  start: number;
  end: number;
  text: string;
  protected: string[];
}

export class LatexMarkerError extends Error {
  constructor() {
    super("模型改动了 LaTeX 保护标记。");
  }
}

// Keep texttt opaque: filenames, dataset keys and code must remain verbatim.
const TEXT_COMMANDS = new Set(
  "title subtitle section subsection subsubsection paragraph subparagraph chapter part caption subcaption footnote textbf textit emph textrm textsf textnormal underline abstract keywords thanks".split(
    " ",
  ),
);
const OPAQUE_ENVIRONMENTS = new Set(
  "equation equation* align align* aligned gather gather* multline multline* displaymath math eqnarray eqnarray* verbatim verbatim* Verbatim lstlisting minted tikzpicture picture tabular tabular* tabularx array thebibliography filecontents filecontents* comment".split(
    " ",
  ),
);

function groupEnd(source: string, start: number): number {
  const open = source[start];
  const close = open === "{" ? "}" : "]";
  let depth = 1;
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "%") {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
    } else if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return i + 1;
  }
  throw new Error("LaTeX 源码存在未闭合的参数。");
}

function commandAt(source: string, start: number) {
  const match = /^\\([a-zA-Z@]+\*?|[^\r\n])/.exec(source.slice(start));
  return match
    ? { name: match[1].replace(/\*$/, ""), end: start + match[0].length }
    : null;
}

/** Comments and verbatim are removed only for structural discovery. */
export function stripLatexComments(source: string): string {
  return source.replace(
    /\\verb\*?([^\w\s])[^\r\n]*?\1|\\[%\\]|%[^\r\n]*/g,
    (text) =>
      text.startsWith("%") || text.startsWith("\\verb")
        ? " ".repeat(text.length)
        : text,
  );
}

export function findMainFile(
  files: Map<string, string>,
  configured = "",
): string {
  if (configured) {
    if (
      !files.has(configured) ||
      !/\\documentclass\b/.test(stripLatexComments(files.get(configured)!))
    )
      throw new Error("指定的 LaTeX 主文件不存在或没有 documentclass。");
    return configured;
  }
  const candidates = [...files].filter(([, text]) =>
    /\\documentclass\b/.test(stripLatexComments(text)),
  );
  if (candidates.length === 1) return candidates[0][0];
  const main = candidates.filter(([name]) => /(^|\/)main\.tex$/i.test(name));
  if (main.length === 1) return main[0][0];
  throw new Error(
    `无法唯一确定 LaTeX 主文件，请在轻量后端设置中填写相对路径。候选：${candidates.map(([name]) => name).join("、") || "无"}`,
  );
}

export function resolveTexInput(
  from: string,
  input: string,
  files: Map<string, string>,
  root = from,
): string {
  if (/^[/\\]|[:\\#]/.test(input))
    throw new Error(`不支持的 LaTeX 引用路径：${input}`);
  const resolve = (parent: string) => {
    const parts = parent.split("/").slice(0, -1);
    for (const part of input.split("/")) {
      if (part === "..") {
        if (!parts.length) throw new Error("LaTeX 引用超出项目目录。");
        parts.pop();
      } else if (part && part !== ".") parts.push(part);
    }
    const path = parts.join("/");
    return files.has(path) ? path : `${path}.tex`;
  };
  // TeX resolves normal input paths from the compilation working directory.
  const candidates = [resolve(root), resolve(from)];
  const found = candidates.find((name) => files.has(name));
  if (!found) throw new Error(`未找到 LaTeX 引用文件：${from} → ${input}`);
  return found;
}

export function planLatex(
  source: string,
  fragment = false,
): { units: LatexUnit[]; inputs: { path: string; body: boolean }[] } {
  const units: LatexUnit[] = [];
  const inputs: { path: string; body: boolean }[] = [];
  let body = fragment;
  let start = 0;
  let text = "";
  let protectedParts: string[] = [];
  let prose = "";
  const protect = (value: string) => {
    text += `[[HJFY_${protectedParts.length}]]`;
    protectedParts.push(value);
  };
  const flush = (end: number) => {
    if (/[a-zA-Z]{2,}/.test(prose))
      units.push({ start, end, text, protected: protectedParts });
    start = end;
    text = "";
    prose = "";
    protectedParts = [];
  };
  const scan = (from: number, to: number, active: boolean) => {
    for (let i = from; i < to; ) {
      const char = source[i];
      if (char === "%") {
        const newline = source.indexOf("\n", i);
        const end = newline < 0 ? to : Math.min(to, newline + 1);
        protect(source.slice(i, end));
        i = end;
      } else if (/^\r?\n[\t ]*\r?\n/.test(source.slice(i))) {
        flush(i);
        const blank = /^\r?\n[\t ]*\r?\n/.exec(source.slice(i))![0];
        i += blank.length;
        start = i;
      } else if (
        char === "$" ||
        source.startsWith("\\(", i) ||
        source.startsWith("\\[", i)
      ) {
        const delimiter =
          char === "$"
            ? source[i + 1] === "$"
              ? "$$"
              : "$"
            : source.slice(i, i + 2);
        const close =
          delimiter === "\\(" ? "\\)" : delimiter === "\\[" ? "\\]" : delimiter;
        let end = i + delimiter.length;
        for (; end < to; end++) {
          if (source.startsWith(close, end)) break;
          if (source[end] === "\\") end++;
        }
        if (end >= to) throw new Error("LaTeX 公式未闭合。");
        end += close.length;
        protect(source.slice(i, end));
        i = end;
      } else if (char === "\\") {
        const command = commandAt(source, i);
        if (!command) {
          protect(char);
          i++;
          continue;
        }
        let end = command.end;
        if (["def", "gdef", "edef", "xdef"].includes(command.name)) {
          const opening = source.indexOf("{", end);
          if (opening < 0) throw new Error("LaTeX 宏定义不完整。");
          end = groupEnd(source, opening);
        } else if (command.name === "csname") {
          const close = source.indexOf("\\endcsname", end);
          if (close < 0) throw new Error("LaTeX csname 未闭合。");
          end = close + "\\endcsname".length;
        } else if (command.name === "verb") {
          const delimiter = source[end];
          const close = source.indexOf(delimiter, end + 1);
          if (close < 0 || /[\r\n]/.test(source.slice(end, close)))
            throw new Error("LaTeX verb 未闭合。");
          end = close + 1;
        } else {
          const groups: { start: number; end: number; open: string }[] = [];
          for (;;) {
            const next = /^\s*/.exec(source.slice(end))![0].length + end;
            if (!["{", "["].includes(source[next])) break;
            const group = {
              start: next,
              end: groupEnd(source, next),
              open: source[next],
            };
            groups.push(group);
            end = group.end;
          }
          const argument = groups.find((group) => group.open === "{");
          const value = argument
            ? source.slice(argument.start + 1, argument.end - 1)
            : "";
          if (command.name === "begin" && OPAQUE_ENVIRONMENTS.has(value)) {
            const marker = `\\end{${value}}`;
            const close = source.indexOf(marker, end);
            if (close < 0) throw new Error(`LaTeX 环境未闭合：${value}`);
            end = close + marker.length;
          } else if (
            (command.name === "begin" || command.name === "end") &&
            value === "document"
          ) {
            end = argument!.end;
            flush(i);
            protect(source.slice(i, end));
            flush(end);
            body = command.name === "begin";
            active = body;
            i = end;
            continue;
          } else if (
            (command.name === "input" || command.name === "include") &&
            argument
          ) {
            inputs.push({ path: value.trim(), body: active });
          } else if (command.name === "input" || command.name === "include") {
            throw new Error("轻量后端要求 input/include 使用花括号参数。");
          } else if (
            TEXT_COMMANDS.has(command.name) &&
            argument &&
            (active || command.name === "title" || command.name === "subtitle")
          ) {
            // Isolate heading/caption arguments from the surrounding paragraph.
            flush(i);
            start = argument.start + 1;
            scan(argument.start + 1, argument.end - 1, true);
            flush(argument.end - 1);
            start = end;
            i = end;
            continue;
          }
        }
        protect(source.slice(i, end));
        i = end;
      } else if (!active || /[{}&#_^~]/.test(char)) {
        protect(char);
        i++;
      } else {
        text += char;
        prose += char;
        i++;
      }
    }
  };
  scan(0, source.length, body);
  flush(source.length);
  return { units, inputs };
}

export function restoreLatex(unit: LatexUnit, translated: string): string {
  if (typeof translated !== "string" || !translated.trim())
    throw new Error("模型返回空译文。");
  const expected = unit.protected.map((_, index) => `[[HJFY_${index}]]`);
  const actual = translated.match(/\[\[HJFY_\d+\]\]/g) || [];
  if (actual.join("|") !== expected.join("|")) throw new LatexMarkerError();
  const prose = translated.replace(/\[\[HJFY_\d+\]\]/g, "");
  if (/[\\{}$%&#_^~]|\[\[HJFY_|```/.test(prose))
    throw new Error("模型在译文中引入了未转义的 TeX 语法。");
  const original = unit.text.replace(/\[\[HJFY_\d+\]\]/g, "").trim();
  // A standalone scientific acronym (e.g. LIBERO.) needs no Chinese rendering.
  const unchangedAcronym =
    /^[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*[.:]?$/.test(original) &&
    (original.match(/[A-Z]/g)?.length || 0) >= 2 &&
    translated.trim() === unit.text.trim();
  if (
    /[a-zA-Z]{2,}/.test(original) &&
    !/[\u3400-\u9fff]/.test(prose) &&
    !unchangedAcronym
  )
    throw new Error("模型未返回中文译文。");
  return translated.replace(
    /\[\[HJFY_(\d+)\]\]/g,
    (_, index) => unit.protected[Number(index)],
  );
}

export function applyLatexUnits(
  source: string,
  units: LatexUnit[],
  translations: string[],
): string {
  if (translations.length !== units.length)
    throw new Error("译文段落数量不匹配。");
  for (let i = units.length - 1; i >= 0; i--) {
    source =
      source.slice(0, units[i].start) +
      restoreLatex(units[i], translations[i]) +
      source.slice(units[i].end);
  }
  return source;
}

export function addChineseSupport(source: string): string {
  const clean = stripLatexComments(source);
  if (
    /\\(?:documentclass(?:\[[^\]]*\])?\{ctex|usepackage(?:\[[^\]]*\])?\{[^}]*\bctex\b)/.test(
      clean,
    )
  )
    return source;
  const command = /\\documentclass(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/.exec(clean);
  if (!command) throw new Error("LaTeX 主文件缺少 documentclass。");
  const offset = command.index + command[0].length;
  return (
    source.slice(0, offset) +
    "\n\\usepackage[UTF8,fontset=fandol]{ctex}\n" +
    source.slice(offset)
  );
}
