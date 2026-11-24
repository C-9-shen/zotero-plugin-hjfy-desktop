import { maskLatexExamples } from "./source";

/** Disable standalone pdfTeX-only commands in a XeTeX compilation copy. */
export function prepareTectonicSource(source: string) {
  const clean = maskLatexExamples(source);
  const lines: number[] = [];
  let output = "";
  let end = 0;
  for (const match of clean.matchAll(
    /^[\t ]*(?:(?:\\global[\t ]*)?\\(?:pdfoutput|pdfgentounicode)[\t ]*(?:=[\t ]*)?[+-]?\d+(?:[\t ]*\\relax)?|\\input[\t ]*\{glyphtounicode(?:\.tex)?\}|\\DisableLigatures[\t ]*(?:\[[^\r\n\]]*\][\t ]*)?\{[^{}\r\n]*\})(?=[\t ]*\r?$)/gm,
  )) {
    lines.push(source.slice(0, match.index).split("\n").length);
    // Blank just the command. Keep comments, newlines and all other syntax.
    output += source.slice(end, match.index) + " ".repeat(match[0].length);
    end = match.index + match[0].length;
  }
  return { source: output + source.slice(end), lines };
}

/** Reuse the archive's finished BibTeX bibliography instead of regenerating it. */
export function prepareBundledBibliography(source: string) {
  const clean = maskLatexExamples(source);
  let output = "";
  let end = 0;
  let replacements = 0;
  for (const match of clean.matchAll(
    /\\(bibliography|bibliographystyle)\s*\{[^{}]*\}/g,
  )) {
    // Preserve embedded comments/newlines, including a comment's terminating
    // newline, so changing the command cannot comment out subsequent content.
    const original = source.slice(match.index, match.index + match[0].length);
    const comments = original.replace(/%[^\r\n]*|[^\r\n]/g, (text) =>
      text.startsWith("%") ? text : " ",
    );
    output += source.slice(end, match.index);
    if (match[1] === "bibliography") {
      output += "\\input{\\jobname.bbl}";
      replacements++;
    }
    output += comments;
    end = match.index + match[0].length;
  }
  return { source: output + source.slice(end), replacements };
}

/** A zero engine exit code can still leave every citation unresolved. */
export function assertResolvedReferences(log: string) {
  const warnings = log.match(
    /(?:LaTeX|Package\s+[^\r\n]+) Warning:\s*(?:(?:Citation|Reference)\s+[^\r\n]*(?:\r?\n[^\r\n]*){0,3}?\bundefined\b|There were undefined (?:references|citations)\.)/g,
  );
  if (warnings?.length)
    throw new Error(
      "便携 TeX 编译后仍有未解析的文献引用或交叉引用，未导入含问号的译文。请检查诊断目录中的编译日志及源码文献表（.bbl / .bib）。\n" +
        warnings
          .slice(0, 3)
          .map((text) => text.replace(/\s+/g, " "))
          .join("\n"),
    );
}
