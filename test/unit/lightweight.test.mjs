import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import { setImmediate } from "node:timers/promises";

const bundle = await build({
  stdin: {
    contents: `export * from './src/modules/latex/source'; export * from './src/modules/latex/pipeline'; export * from './src/modules/latex/api';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const {
  planLatex,
  applyLatexUnits,
  restoreLatex,
  normalizeLatexMarkers,
  findMainFile,
  resolveTexInput,
  addChineseSupport,
  translateLatexProject,
  modelRequest,
  modelResponse,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const chinese = (text) =>
  text.replace(/[a-zA-Z][a-zA-Z ,.!?:;'-]*/g, (value) =>
    value.startsWith("HJFY_") ? value : "中文译文",
  );
const translateProse = (text) =>
  text
    .split(/(\[\[HJFY_\d+\]\])/)
    .map((part) => (part.startsWith("[[HJFY_") ? part : chinese(part)))
    .join("");
const mapBatch = (text, transform) => {
  const batch = JSON.parse(text);
  batch.segments = batch.segments.map((segment) => ({
    ...segment,
    text: transform(segment.text, segment.id),
  }));
  return JSON.stringify(batch);
};
const translate = (text) => {
  if (text.startsWith('{"segments":')) return mapBatch(text, translateProse);
  return translateProse(text);
};
const hash = async (text) => createHash("sha256").update(text).digest("hex");

test("LaTeX scanner preserves formulas, syntax, tables, authors, comments and macro definitions", () => {
  const source = String.raw`% \documentclass{fake}
\documentclass{article}
\title{A scientific paper}
\author{Alice Smith}
\newcommand{\method}{Original Method}
\begin{document}
\section{Introduction}
We study $x_i^2$ and \cite{key} with \method. % Keep this comment

\textbf{Useful result} with \ref{sec:test}.
\def\foo#1{Never translate #1}
\begin{equation}x &= y\end{equation}
\begin{tabular}{ll}Name & Value \\ A & 1\end{tabular}
\caption{A useful figure}
\begin{verbatim}Code remains unchanged.\end{verbatim}
\end{document}`;
  const plan = planLatex(source);
  const output = applyLatexUnits(
    source,
    plan.units,
    plan.units.map((unit) => translate(unit.text)),
  );
  for (const original of [
    String.raw`\author{Alice Smith}`,
    String.raw`\newcommand{\method}{Original Method}`,
    String.raw`\def\foo#1{Never translate #1}`,
    String.raw`$x_i^2$`,
    String.raw`\cite{key}`,
    "% Keep this comment\n",
    String.raw`\begin{equation}x &= y\end{equation}`,
    String.raw`\begin{tabular}{ll}Name & Value \\ A & 1\end{tabular}`,
    "Code remains unchanged.",
  ])
    assert.ok(output.includes(original), original);
  assert.ok(!output.includes("A scientific paper"));
  assert.ok(!output.includes("Introduction"));
  assert.ok(output.includes("中文译文"));
  assert.ok(
    addChineseSupport(output).includes(
      String.raw`\usepackage[UTF8,fontset=fandol]{ctex}`,
    ),
  );
  assert.equal(
    addChineseSupport(addChineseSupport(output)),
    addChineseSupport(output),
  );
});

test("paragraph extraction keeps nested inline formatting and footnotes in context with independent block units", () => {
  const source = String.raw`\documentclass{article}
\title{A test title}
\author{Alice Smith}
\newcommand{\custom}[1]{#1}
\begin{document}
\section{Introduction}
First sentence with \textbf{important \emph{nested words}} and $x_i$.
Still the same paragraph with \cite{ref}.

Second paragraph has \emph{emphasized words} and \custom{Custom prose here}.
A footnote\footnote[2]{Detailed \textit{footnote prose}.} ends here.
\begin{itemize}
\item First list item.
\item Second list item.
\end{itemize}
\begin{tabular}{ll}Column name & Column value \\ Entry & Test\end{tabular}
\caption{A figure caption with $z$.}
\end{document}`;
  const { units } = planLatex(source);
  assert.equal(units.length, 7);
  const fragments = units.map((unit) => restoreLatex(unit, unit.text).trim());
  assert.deepEqual(fragments, [
    "A test title",
    "Introduction",
    String.raw`First sentence with \textbf{important \emph{nested words}} and $x_i$.
Still the same paragraph with \cite{ref}.`,
    String.raw`Second paragraph has \emph{emphasized words} and \custom{Custom prose here}.
A footnote\footnote[2]{Detailed \textit{footnote prose}.} ends here.`,
    "First list item.",
    "Second list item.",
    "A figure caption with $z$.",
  ]);
  assert.equal(
    applyLatexUnits(
      source,
      units,
      units.map((unit) => unit.text),
    ),
    source,
  );
  for (let i = 1; i < units.length; i++)
    assert.ok(units[i - 1].end <= units[i].start);
  const output = applyLatexUnits(
    source,
    units,
    units.map((u) => translate(u.text)),
  );
  for (const original of [
    String.raw`\author{Alice Smith}`,
    String.raw`\newcommand{\custom}[1]{#1}`,
    String.raw`\custom{Custom prose here}`,
    String.raw`\begin{tabular}{ll}Column name & Column value \\ Entry & Test\end{tabular}`,
    String.raw`\footnote[2]{`,
    String.raw`\textbf{`,
    String.raw`\emph{`,
    String.raw`\textit{`,
    String.raw`$x_i$`,
    String.raw`\cite{ref}`,
  ])
    assert.ok(output.includes(original), original);
  assert.ok(!output.includes("important"));
  assert.ok(!output.includes("footnote prose"));
  assert.ok(!output.includes("First list item"));

  const paragraph = units[2];
  assert.ok(paragraph.text.includes("First sentence"));
  assert.ok(paragraph.text.includes("nested words"));
  assert.ok(paragraph.text.includes("Still the same paragraph"));
  assert.throws(
    () => restoreLatex(paragraph, paragraph.text.replace("[[HJFY_0]]", "")),
    /保护标记/,
  );
  assert.throws(
    () =>
      restoreLatex(paragraph, paragraph.text + String.raw`\textit{injected}`),
    /TeX/,
  );
});

test("block boundaries isolate nested lists, display math, environments and included files", () => {
  const source = String.raw`Before the list.
\begin{enumerate}
\item[First] {Outer prose \textbf{with formatting}.}
\begin{itemize}
\item Nested prose.
\end{itemize}
\item Second outer prose.
\end{enumerate}
After the list.\par Following paragraph.
$$x = y$$
Before equation.\begin{equation}z=1\end{equation}After equation.
\[w = 2\]
Before input.\input{section}After input.
\begin{abstract}Abstract prose.\end{abstract}`;
  const { units, inputs } = planLatex(source, true);
  assert.deepEqual(inputs, [{ path: "section", body: true }]);
  assert.deepEqual(
    units.map((u) => restoreLatex(u, u.text).trim()),
    [
      "Before the list.",
      String.raw`{Outer prose \textbf{with formatting}.}`,
      "Nested prose.",
      "Second outer prose.",
      "After the list.",
      "Following paragraph.",
      "Before equation.",
      "After equation.",
      "Before input.",
      "After input.",
      "Abstract prose.",
    ],
  );
  assert.equal(
    applyLatexUnits(
      source,
      units,
      units.map((u) => u.text),
    ),
    source,
  );
});

test("inline recursion preserves paragraph breaks, comments, opaque commands and nested environments", () => {
  const source = String.raw`The result \textbf{has nested \emph{important} prose} continues.
A note\footnote{First note paragraph.

Second note paragraph with \texttt{file\_name} and $x$.
\begin{itemize}\item A note item.\end{itemize}
% Keep comment braces { intact
Final note sentence.} ends the same paragraph.`;
  for (const newline of ["\n", "\r\n"]) {
    const input = source.replace(/\n/g, newline);
    const { units } = planLatex(input, true);
    assert.equal(units.length, 1);
    assert.ok(units[0].text.includes("Final note sentence"));
    assert.ok(units[0].text.includes("ends the same paragraph"));
    assert.equal(restoreLatex(units[0], units[0].text), input);
    const output = restoreLatex(units[0], translate(units[0].text));
    assert.ok(output.includes(String.raw`\texttt{file\_name}`));
    assert.ok(output.includes("% Keep comment braces { intact" + newline));
    assert.ok(output.includes(newline + newline));
  }
});

test("LaTeX validation rejects token corruption and introduced syntax while accepting English output", () => {
  const unit = planLatex("A result $x$ is useful.", true).units[0];
  assert.throws(() => restoreLatex(unit, "结果很有用。"), /保护标记/);
  assert.throws(
    () => restoreLatex(unit, "结果 [[HJFY_0]] \\input{evil}"),
    /TeX/,
  );
  assert.equal(restoreLatex(unit, "结果 [[HJFY_0]][[HJFY_0]]"), "结果 $x$$x$");
  assert.equal(restoreLatex(unit, unit.text), "A result $x$ is useful.");
  assert.throws(() => planLatex("An unclosed $formula", true), /公式未闭合/);
  assert.throws(() => planLatex(String.raw`\input chapter`, true), /花括号/);
  assert.equal(
    restoreLatex(unit, "结果 [[HJFY_0]] 很有用。"),
    "结果 $x$ 很有用。",
  );
});

test("restoring protected control words keeps their boundary before translated letters and cached output", async () => {
  const source = String.raw`\documentclass{article}
\newcommand{\modelname}{Rollback}
\begin{document}
Experiments show \modelname achieves better results.
\end{document}`;
  const unit = planLatex(source).units[0];
  const cached = "实验表明[[HJFY_0]]实现了更好的结果。";
  assert.equal(
    restoreLatex(unit, cached),
    String.raw`实验表明\modelname 实现了更好的结果。`,
  );
  for (const tail of [" 实现", "。", "2", ""]) {
    assert.equal(
      restoreLatex(unit, `结果[[HJFY_0]]${tail}`),
      String.raw`结果\modelname` + tail,
    );
  }
  assert.equal(
    restoreLatex(unit, "结果[[HJFY_0]]Rollback"),
    String.raw`结果\modelname Rollback`,
  );
  const grouped = planLatex(String.raw`The \modelname{} result.`, true)
    .units[0];
  assert.equal(
    restoreLatex(grouped, "这个[[HJFY_0]]结果。"),
    String.raw`这个\modelname{}结果。`,
  );
  const before = cached;
  let requests = 0;
  const output = await translateLatexProject(
    new Map([["main.tex", source]]),
    {
      cacheKey: "cached-boundary",
      translate: async () => {
        requests++;
        return cached;
      },
    },
    {
      read: async () => cached,
      write: async () => assert.fail("Must reuse cache"),
    },
    hash,
    () => {},
    () => {},
  );
  assert.equal(requests, 0);
  assert.equal(output.cacheHits, 1);
  assert.equal(cached, before);
  assert.ok(output.files.get("main.tex").includes(String.raw`\modelname 实现`));
});

test("numeric TeX layout assignments stay protected and invalidate only affected segment caches", async () => {
  for (const assignment of [
    String.raw`\looseness=-1`,
    String.raw`\tolerance 1000`,
    String.raw`\widowpenalty = 10000`,
  ]) {
    const source = assignment + " A useful result.";
    const unit = planLatex(source, true).units[0];
    assert.deepEqual(unit.protected, [assignment]);
    assert.ok(!unit.text.includes("1000"));
    assert.equal(restoreLatex(unit, "[[HJFY_0]]译文。"), assignment + "译文。");
    const command = /^\\[a-z]+/.exec(assignment)[0];
    const old = {
      text: "[[HJFY_0]]" + source.slice(command.length),
      protected: [command],
    };
    assert.notEqual(
      await hash(
        JSON.stringify(["hjfy-lite-v1", "provider", unit.text, unit.protected]),
      ),
      await hash(
        JSON.stringify(["hjfy-lite-v1", "provider", old.text, old.protected]),
      ),
    );
  }
});

test("filenames and dataset keys stay opaque inside translated paragraphs", () => {
  const source = String.raw`\paragraph{DINO backbones and latent-action quantizers.}
Each variant uses \texttt{laq\_dinov2.pt} or
\texttt{laq\_dinov3.pt} with a separately trained quantizer.

Regression uses \texttt{train\_stride5} and \texttt{val\_stride5}.

Clustering uses \texttt{pos6}; geometry uses \texttt{posgrip8}.`;
  const plan = planLatex(source, true);
  assert.equal(plan.units.length, 4);
  const output = applyLatexUnits(
    source,
    plan.units,
    plan.units.map((unit) => translate(unit.text)),
  );
  for (const literal of [
    String.raw`\texttt{laq\_dinov2.pt}`,
    String.raw`\texttt{laq\_dinov3.pt}`,
    String.raw`\texttt{train\_stride5}`,
    String.raw`\texttt{val\_stride5}`,
    String.raw`\texttt{pos6}`,
    String.raw`\texttt{posgrip8}`,
  ]) {
    assert.ok(output.includes(literal), literal);
    assert.ok(plan.units.some((unit) => unit.protected.includes(literal)));
    assert.ok(
      plan.units.every((unit) => !unit.text.includes(literal.slice(8))),
    );
  }
  assert.equal(planLatex(String.raw`\texttt{pos6}`, true).units.length, 0);
  assert.ok(!output.includes("Each variant uses"));
});

test("names and English prose no longer require Chinese characters", () => {
  for (const text of [
    "Robomimic.",
    "RoboEval.",
    "LIBERO.",
    "DINOv2",
    "Introduction",
    "or",
    "A useful result.",
  ]) {
    const unit = planLatex(text, true).units[0];
    assert.equal(restoreLatex(unit, text), text);
  }
  const unit = planLatex("RoboEval.", true).units[0];
  assert.equal(restoreLatex(unit, "RoboEval"), "RoboEval");
  assert.throws(() => restoreLatex(unit, ""), /空译文/);
});

test("project discovery excludes commented roots and prevents path escape", () => {
  const files = new Map([
    [
      "paper/main.tex",
      String.raw`% \documentclass{fake}
\documentclass{article}`,
    ],
    ["paper/sec/intro.tex", "A useful paragraph."],
    ["other.tex", "% \\documentclass{fake}"],
  ]);
  assert.equal(findMainFile(files), "paper/main.tex");
  assert.equal(
    resolveTexInput("paper/main.tex", "sec/intro", files),
    "paper/sec/intro.tex",
  );
  assert.throws(
    () => resolveTexInput("paper/main.tex", "../../outside", files),
    /超出/,
  );
  assert.throws(
    () => resolveTexInput("paper/main.tex", "C:/secret", files),
    /不支持/,
  );
  assert.throws(
    () =>
      findMainFile(
        new Map([
          ["a.tex", "\\documentclass{article}"],
          ["b.tex", "\\documentclass{article}"],
        ]),
      ),
    /唯一/,
  );
});

test("pipeline translates reachable prose, retries invalid replies and reuses validated cache", async () => {
  const files = new Map([
    [
      "main.tex",
      String.raw`\documentclass{article}
\input{preamble}
\title{Scientific results}
\begin{document}
\input{sec/introduction}
\end{document}`,
    ],
    ["preamble.tex", String.raw`\newcommand{\method}{My Method}`],
    [
      "sec/introduction.tex",
      "We study $x$ and results.\n\nAnother useful result.",
    ],
    ["unrelated.tex", "Do not translate this file."],
  ]);
  const values = new Map();
  let calls = 0;
  const provider = {
    cacheKey: "fixture",
    translate: async (text) => {
      calls++;
      return calls === 1 ? "invalid reply" : translate(text);
    },
  };
  const cache = {
    read: async (key) => values.get(key),
    write: async (key, text) => {
      values.set(key, text);
    },
  };
  const first = await translateLatexProject(
    files,
    provider,
    cache,
    hash,
    () => {},
    () => {},
  );
  assert.equal(first.requested, 3);
  assert.equal(first.cacheHits, 0);
  assert.equal(calls, 3);
  assert.equal(first.files.get("preamble.tex"), files.get("preamble.tex"));
  assert.equal(first.files.get("unrelated.tex"), files.get("unrelated.tex"));
  assert.ok(first.files.get("sec/introduction.tex").includes("$x$"));
  const second = await translateLatexProject(
    files,
    provider,
    cache,
    hash,
    () => {},
    () => {},
  );
  assert.equal(second.cacheHits, 3);
  assert.equal(calls, 3);
  assert.deepEqual(first.files, second.files);
  await assert.rejects(
    translateLatexProject(
      files,
      provider,
      cache,
      hash,
      () => {},
      () => {
        throw new Error("cancelled");
      },
    ),
    /cancelled/,
  );
});

test("complete paragraphs share a batch while changed extraction reuses only unaffected old cache entries", async () => {
  const source = String.raw`\documentclass{article}
\begin{document}
A result with \textbf{important words} continues with a footnote\footnote{A detailed note.}.

An unchanged paragraph.
\end{document}`;
  const cacheKey = "paragraph-context";
  const key = (unit) =>
    hash(JSON.stringify(["hjfy-lite-v1", cacheKey, unit.text, unit.protected]));
  const unchanged = planLatex(source).units[1];
  const oldFragment = { text: "important words", protected: [] };
  const values = new Map([
    [await key(unchanged), "已缓存段落。\n"],
    [await key(oldFragment), "旧版碎片译文"],
  ]);
  const calls = [];
  const run = () =>
    translateLatexProject(
      new Map([["main.tex", source]]),
      {
        cacheKey,
        translate: async (text) => {
          calls.push(JSON.parse(text));
          return translate(text);
        },
      },
      {
        read: async (key) => values.get(key),
        write: async (key, value) => values.set(key, value),
      },
      hash,
      () => {},
      () => {},
    );
  const first = await run();
  assert.equal(first.requested, 2);
  assert.equal(first.cacheHits, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].segments.length, 1);
  const paragraph = calls[0].segments[0];
  assert.equal(paragraph.id, 1);
  for (const context of ["A result with", "important words", "A detailed note"])
    assert.ok(paragraph.text.includes(context));
  const output = first.files.get("main.tex");
  assert.ok(output.includes("已缓存段落"));
  assert.ok(!output.includes("旧版碎片译文"));
  assert.ok(output.includes(String.raw`\textbf{中文译文}`));
  assert.ok(output.includes(String.raw`\footnote{中文译文}`));
  const second = await run();
  assert.equal(second.cacheHits, 2);
  assert.equal(second.requests, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(first.files, second.files);
});

test("rerunning a failed project reuses successful segments without another model request", async () => {
  const files = new Map([
    [
      "main.tex",
      String.raw`\documentclass{article}
\begin{document}
First useful result.

Second useful result.

\input{last}
\end{document}`,
    ],
    ["last.tex", "Last useful result."],
  ]);
  const values = new Map();
  const cache = {
    read: async (key) => values.get(key),
    write: async (key, value) => {
      values.set(key, value);
    },
  };
  let fail = true;
  const calls = [];
  const provider = {
    cacheKey: "resume-fixture",
    translate: async (text) => {
      calls.push(text);
      return fail && text.includes("Last useful")
        ? "invalid batch"
        : translate(text);
    },
  };
  const run = () =>
    translateLatexProject(
      files,
      provider,
      cache,
      hash,
      () => {},
      () => {},
    );
  await assert.rejects(run(), /last.tex 第 1–1 段：模型未返回有效的批量 JSON/);
  assert.equal(values.size, 2);
  fail = false;
  calls.length = 0;
  const result = await run();
  assert.equal(result.cacheHits, 2);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("Last useful"));
  assert.equal(values.size, 3);
});

test("batches merge uncached paragraphs, keep local tokens, respect limits and preserve per-segment caches", async () => {
  for (const length of [0, 65]) {
    const paragraphs = Array.from(
      { length: 75 },
      (_, i) =>
        `Result ${i}: ` +
        String.raw`\method improves $x_${i}$ and \ref{sec:${i}}. ` +
        "Additional context. ".repeat(length),
    );
    const source =
      "\\documentclass{article}\\begin{document}\n" +
      paragraphs.join("\n\n") +
      "\n\\end{document}";
    const units = planLatex(source).units;
    const values = new Map();
    const cacheKey = `batch-limits-${length}`;
    for (const unit of units.slice(0, 3))
      values.set(
        await hash(
          JSON.stringify(["hjfy-lite-v1", cacheKey, unit.text, unit.protected]),
        ),
        translate(unit.text),
      );
    const calls = [];
    let active = 0,
      maximum = 0;
    const provider = {
      cacheKey,
      translate: async (text) => {
        calls.push(text);
        active++;
        maximum = Math.max(maximum, active);
        const { segments } = JSON.parse(text);
        let markerCount = 0;
        assert.ok(segments.length <= 32);
        for (const segment of segments) {
          const tokens = segment.text.match(/\[\[HJFY_\d+\]\]/g) || [];
          assert.deepEqual(
            tokens,
            tokens.map((_, i) => `[[HJFY_${i}]]`),
          );
          markerCount += tokens.length;
        }
        assert.ok(markerCount <= 48);
        assert.ok(text.length <= 12000);
        assert.ok(!text.includes("Result 0:"));
        await setImmediate();
        active--;
        return translate(text);
      },
    };
    const run = () =>
      translateLatexProject(
        new Map([["main.tex", source]]),
        provider,
        {
          read: async (key) => values.get(key),
          write: async (key, value) => {
            values.set(key, value);
          },
        },
        hash,
        () => {},
        () => {},
      );
    const first = await run();
    assert.equal(first.cacheHits, 3);
    assert.equal(first.requested, 75);
    assert.ok(calls.length < 15);
    assert.equal(maximum, 2);
    assert.equal(values.size, 75);
    if (!length) assert.equal(calls.length, 5);
    const output = first.files.get("main.tex");
    for (let i = 0; i < 75; i++) {
      assert.ok(output.includes(`$x_${i}$`));
      assert.ok(output.includes(`\\ref{sec:${i}}`));
    }
    assert.ok(output.includes(String.raw`\method 中文`));
    const count = calls.length;
    const second = await run();
    assert.equal(second.cacheHits, 75);
    assert.equal(second.requests, 0);
    assert.equal(calls.length, count);
    assert.deepEqual(first.files, second.files);
  }
});

test("marker retry supplies explicit token feedback before accepting a corrected response", async () => {
  const files = new Map([
    [
      "main.tex",
      String.raw`\documentclass{article}\begin{document}A result $x$ is useful.\end{document}`,
    ],
  ]);
  const calls = [];
  const values = new Map();
  const result = await translateLatexProject(
    files,
    {
      cacheKey: "retry-feedback",
      translate: async (text, feedback) => {
        calls.push({ text, feedback });
        return calls.length === 1 ? "结果很有用。" : translate(text);
      },
    },
    {
      read: async (key) => values.get(key),
      write: async (key, value) => {
        values.set(key, value);
      },
    },
    hash,
    () => {},
    () => {},
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].feedback, "");
  assert.ok(calls[1].feedback.includes("[[HJFY_0]]"));
  assert.ok(result.files.get("main.tex").includes("$x$"));
  assert.equal(values.size, 1);
});

test("corrupted syntax tokens retry the batch without phrase requests or cache pollution", async () => {
  const files = new Map([
    [
      "main.tex",
      String.raw`\documentclass{article}\begin{document}
First observation $x$ gives a result.

Second observation $y$ confirms the result.
\end{document}`,
    ],
  ]);
  for (const damage of [
    (text) => mapBatch(text, (value) => value.replace("[[HJFY_0]]", "")),
    (text) =>
      mapBatch(text, (value) => value.replace("[[HJFY_0]]", "[[HJFY_1]]")),
    (text) => mapBatch(text, (value) => value + "[[HJFY_99]]"),
  ]) {
    const calls = [],
      values = new Map();
    await assert.rejects(
      translateLatexProject(
        files,
        {
          cacheKey: "broken-batch",
          translate: async (text) => {
            calls.push(text);
            return damage(translate(text));
          },
        },
        {
          read: async (key) => values.get(key),
          write: async (key, value) => {
            values.set(key, value);
          },
        },
        hash,
        () => {},
        () => {},
      ),
      /保护标记/,
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0], calls[1]);
    assert.ok(calls[0].includes("First observation"));
    assert.ok(calls[0].includes("Second observation"));
    assert.equal(values.size, 0);
  }
});

test("batch validation rejects empty segments, injected syntax and text outside JSON and honors cancellation", async () => {
  const files = new Map([
    [
      "main.tex",
      String.raw`\documentclass{article}\begin{document}A useful result.\end{document}`,
    ],
  ]);
  for (const mode of ["empty", "syntax", "outside", "cancel"]) {
    let calls = 0,
      cancelled = false;
    const values = new Map();
    await assert.rejects(
      translateLatexProject(
        files,
        {
          cacheKey: "invalid-batch",
          translate: async (text) => {
            calls++;
            if (mode === "cancel") cancelled = true;
            if (mode === "empty") return text.replace("A useful result.", "");
            if (mode === "syntax")
              return mapBatch(text, () => String.raw`译文\input{evil}`);
            if (mode === "outside")
              return "extra explanation" + translate(text);
            return translate(text);
          },
        },
        {
          read: async (key) => values.get(key),
          write: async (key, value) => {
            values.set(key, value);
          },
        },
        hash,
        () => {},
        () => {
          if (cancelled) throw Error("cancelled");
        },
      ),
      mode === "cancel"
        ? /cancelled/
        : mode === "empty"
          ? /空译文/
          : mode === "outside"
            ? /JSON/
            : /TeX/,
    );
    assert.equal(calls, mode === "cancel" ? 1 : 2);
    assert.equal(values.size, 0);
  }
});

test("marker typography repairs stay confined to complete tokens and never infer missing tokens", () => {
  const unit = planLatex("A result $x$ and $y$ is useful.", true).units[0];
  for (const first of [
    "[[HJFY_0]]",
    String.raw`\[\[HJFY_0\]\]`,
    "［［HJFY_0］］",
    "[ [ HJFY_ 0 ] ]",
    "`[[HJFY_0]]`",
  ]) {
    assert.equal(
      restoreLatex(unit, `结果${first}与[[HJFY_1]]。`),
      "结果$x$与$y$。",
    );
  }
  const literal = String.raw`普通［方括号］和 \[literal\] 不应改动。`;
  assert.equal(normalizeLatexMarkers(literal), literal);
  for (const text of [
    "结果[[HJFY_0]]",
    "结果[[HJFY_0]][[HJFY_2]]",
    "结果[[HJFY_0]][HJFY_1]",
  ])
    assert.throws(() => restoreLatex(unit, text), /保护标记/);
});

test("desktop-style marker restoration accepts reordering and repetitions while rejecting missing and unknown identities", () => {
  const unit = planLatex(
    String.raw`We construct samples $(h_t,A_t,q)$ from trajectory $\tau$ at time $t$ with label $q(\tau)$ and \citep[see]{paper} using \eqref{eq:loss}.`,
    true,
  ).units[0];
  assert.equal(
    restoreLatex(
      unit,
      "在时间步 [[HJFY_2]] 切分轨迹 [[HJFY_1]] 并附加标签 [[HJFY_3]]，构造样本 [[HJFY_0]]，使用 [[HJFY_5]]，参见 [[HJFY_4]]。",
    ),
    String.raw`在时间步 $t$ 切分轨迹 $\tau$ 并附加标签 $q(\tau)$，构造样本 $(h_t,A_t,q)$，使用 \eqref{eq:loss}，参见 \citep[see]{paper}。`,
  );
  for (const invalid of [
    "译文[[HJFY_0]][[HJFY_1]][[HJFY_2]][[HJFY_3]][[HJFY_4]]",
    "译文[[HJFY_0]][[HJFY_1]][[HJFY_2]][[HJFY_3]][[HJFY_4]][[HJFY_99]]",
  ])
    assert.throws(() => restoreLatex(unit, invalid), /保护标记/);
  const parenthesized = planLatex(
    String.raw`A result \(x\) follows \(y\).`,
    true,
  ).units[0];
  assert.equal(
    restoreLatex(parenthesized, "结果[[HJFY_1]]与[[HJFY_0]]"),
    String.raw`结果\(y\)与\(x\)`,
  );
  assert.equal(
    restoreLatex(parenthesized, "结果[[HJFY_1]]与[[HJFY_0]]再用[[HJFY_1]]"),
    String.raw`结果\(y\)与\(x\)再用\(y\)`,
  );
});

test("desktop-style restoration uses token identities rather than relative syntax positions", () => {
  const swap = (text, a, b) =>
    text.replace(/\[\[HJFY_(\d+)\]\]/g, (token, id) =>
      Number(id) === a
        ? `[[HJFY_${b}]]`
        : Number(id) === b
          ? `[[HJFY_${a}]]`
          : token,
    );
  const formatted = planLatex(
    String.raw`The \textbf{first $x$ and $y$} contrasts $z$.`,
    true,
  ).units[0];
  assert.equal(
    restoreLatex(formatted, swap(formatted.text, 1, 2)),
    String.raw`The \textbf{first $y$ and $x$} contrasts $z$.`,
  );
  assert.equal(
    restoreLatex(formatted, swap(formatted.text, 1, 4)),
    String.raw`The \textbf{first $z$ and $y$} contrasts $x$.`,
  );
  for (const boundary of [
    String.raw`\label{anchor}`,
    String.raw`\custom{opaque $z$}`,
    String.raw`\texttt{data\_key}`,
    "% A comment\n",
    String.raw`\looseness=-1`,
    String.raw`{group}`,
  ]) {
    const unit = planLatex(`A formula $x$ ${boundary} follows $y$.`, true)
      .units[0];
    assert.equal(
      restoreLatex(unit, swap(unit.text, 0, unit.protected.length - 1)),
      `A formula $y$ ${boundary} follows $x$.`,
    );
  }
  const footnote = planLatex(
    String.raw`A result $x$ has a note\footnote{A note $y$ and $z$.} ending.`,
    true,
  ).units[0];
  assert.equal(
    restoreLatex(footnote, swap(footnote.text, 0, 2)),
    String.raw`A result $y$ has a note\footnote{A note $x$ and $z$.} ending.`,
  );
  assert.equal(
    restoreLatex(footnote, swap(footnote.text, 2, 3)),
    String.raw`A result $x$ has a note\footnote{A note $z$ and $y$.} ending.`,
  );
});

test("reordered formula output is accepted on the first request, restored by identity and reused from cache", async () => {
  const paragraph = String.raw`We construct training samples $(h_t,A_t,q)$ by slicing each trajectory $\tau\in\mathcal{D}$ at every time step $t$ and attaching its label $q=q(\tau)$.`;
  const source =
    "\\documentclass{article}\\begin{document}" + paragraph + "\\end{document}";
  const response =
    "我们通过在每个时间步 [[HJFY_2]] 对每条轨迹 [[HJFY_1]] 进行切分并附加其标签 [[HJFY_3]]，构造训练样本 [[HJFY_0]]。";
  const values = new Map();
  let calls = 0;
  const diagnostics = [];
  const run = () =>
    translateLatexProject(
      new Map([["main.tex", source]]),
      {
        cacheKey: "reordered-math-cache",
        translate: async (request) => {
          calls++;
          const { segments } = JSON.parse(request);
          return JSON.stringify({
            segments: [{ id: segments[0].id, text: response }],
          });
        },
        diagnostic: async (record) => diagnostics.push(record),
      },
      {
        read: async (key) => values.get(key),
        write: async (key, value) => {
          values.set(key, value);
        },
      },
      hash,
      () => {},
      () => {},
    );
  const first = await run();
  assert.equal(calls, 1);
  assert.equal(first.requests, 1);
  assert.equal(diagnostics.length, 0);
  assert.ok(
    first.files
      .get("main.tex")
      .includes(String.raw`在每个时间步 $t$ 对每条轨迹 $\tau\in\mathcal{D}$`),
  );
  const second = await run();
  assert.equal(second.cacheHits, 1);
  assert.equal(second.requests, 0);
  assert.equal(calls, 1);
  assert.deepEqual(first.files, second.files);
});

const threeParagraphs = new Map([
  [
    "main.tex",
    String.raw`\documentclass{article}
\begin{document}
First useful result $x$.

Second useful result $y$.

Third useful result $z$.
\end{document}`,
  ],
]);

test("batch IDs restore reordered responses without moving translations between paragraphs", async () => {
  const result = await translateLatexProject(
    threeParagraphs,
    {
      cacheKey: "reordered",
      translate: async (text) => {
        const batch = JSON.parse(
          mapBatch(text, (_, id) => `译文${id}[[HJFY_0]]。`),
        );
        batch.segments.reverse();
        return "```json\n" + JSON.stringify(batch) + "\n```";
      },
    },
    { read: async () => undefined, write: async () => {} },
    hash,
    () => {},
    () => {},
  );
  const output = result.files.get("main.tex");
  assert.ok(output.includes("译文1$x$。"));
  assert.ok(output.includes("译文2$y$。"));
  assert.ok(output.includes("译文3$z$。"));
  assert.equal(result.requests, 1);
});

test("partial batch successes cache immediately and retries contain only invalid or missing IDs", async () => {
  for (const mode of ["missing", "marker", "empty"]) {
    const values = new Map(),
      calls = [],
      diagnostics = [];
    const provider = {
      cacheKey: "partial-" + mode,
      diagnostic: async (record) => diagnostics.push(record),
      translate: async (text, feedback) => {
        calls.push({ text, feedback });
        if (calls.length > 1) {
          assert.equal(
            values.size,
            2,
            "Good paragraphs must be cached before retry",
          );
          assert.deepEqual(
            JSON.parse(text).segments.map((s) => s.id),
            [2],
          );
          assert.ok(feedback.includes('"id":2'));
          return translate(text);
        }
        const batch = JSON.parse(translate(text));
        if (mode === "missing") batch.segments.splice(1, 1);
        if (mode === "marker") batch.segments[1].text = "译文[[HJFY_99]]";
        if (mode === "empty") batch.segments[1].text = "";
        return JSON.stringify(batch);
      },
    };
    const cache = {
      read: async (key) => values.get(key),
      write: async (key, value) => {
        values.set(key, value);
      },
    };
    const run = () =>
      translateLatexProject(
        threeParagraphs,
        provider,
        cache,
        hash,
        () => {},
        () => {},
      );
    const result = await run();
    assert.equal(result.requests, 2);
    assert.equal(values.size, 3);
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0].issues[0].expected, ["[[HJFY_0]]"]);
    assert.deepEqual(diagnostics[0].issues[0].missing, ["[[HJFY_0]]"]);
    assert.equal(diagnostics[0].issues[0].id, 2);
    assert.deepEqual(
      Object.keys(diagnostics[0]).sort(),
      [
        "file",
        "batch",
        "attempt",
        "request",
        "response",
        "error",
        "issues",
      ].sort(),
    );
    assert.equal((await run()).cacheHits, 3);
    assert.equal(calls.length, 2);
  }
});

test("invalid batch identity never contaminates cache and diagnostic failures preserve the original error", async () => {
  for (const mode of [
    "duplicate",
    "unknown",
    "string",
    "no-array",
    "malformed",
  ]) {
    let calls = 0,
      writes = 0,
      diagnostics = 0;
    await assert.rejects(
      translateLatexProject(
        threeParagraphs,
        {
          cacheKey: "identity-" + mode,
          diagnostic: async (record) => {
            diagnostics++;
            assert.ok(record.request.includes("First useful"));
            assert.equal(record.issues.length, 3);
            throw Error("Disk unavailable");
          },
          translate: async (text) => {
            calls++;
            const batch = JSON.parse(translate(text));
            if (mode === "duplicate") batch.segments.push(batch.segments[0]);
            if (mode === "unknown") batch.segments[0].id = 99;
            if (mode === "string") batch.segments[0].id = "1";
            if (mode === "no-array") return "{}";
            if (mode === "malformed") return text.slice(0, -1);
            return JSON.stringify(batch);
          },
        },
        {
          read: async () => undefined,
          write: async () => {
            writes++;
          },
        },
        hash,
        () => {},
        () => {},
      ),
      /JSON/,
    );
    assert.equal(calls, 2);
    assert.equal(diagnostics, 2);
    assert.equal(writes, 0);
  }
});

test("failed partial retry retains good paragraphs and reports exact token differences", async () => {
  const values = new Map(),
    calls = [],
    diagnostics = [];
  const provider = {
    cacheKey: "partial-failure",
    diagnostic: async (record) => diagnostics.push(record),
    translate: async (text) => {
      calls.push(JSON.parse(text).segments.map((s) => s.id));
      return mapBatch(translate(text), (value, id) =>
        id === 2 ? "译文[[HJFY_99]][[HJFY_99]]" : value,
      );
    },
  };
  const cache = {
    read: async (key) => values.get(key),
    write: async (key, value) => {
      values.set(key, value);
    },
  };
  await assert.rejects(
    translateLatexProject(
      threeParagraphs,
      provider,
      cache,
      hash,
      () => {},
      () => {},
    ),
    /第 2 段：.*保护标记.*缺失.*未知/,
  );
  assert.deepEqual(calls, [[1, 2, 3], [2]]);
  assert.equal(values.size, 2);
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(diagnostics[1].issues[0].actual, [
    "[[HJFY_99]]",
    "[[HJFY_99]]",
  ]);
  provider.translate = async (text) => {
    assert.deepEqual(
      JSON.parse(text).segments.map((s) => s.id),
      [2],
    );
    return translate(text);
  };
  assert.equal(
    (
      await translateLatexProject(
        threeParagraphs,
        provider,
        cache,
        hash,
        () => {},
        () => {},
      )
    ).cacheHits,
    2,
  );
});

test("dense paragraphs stay whole even when a single paragraph exceeds the marker budget", async () => {
  const dense =
    "Dense results " +
    Array.from({ length: 60 }, (_, i) => `$x_${i}$`).join(" and ") +
    ".";
  const files = new Map([
    [
      "main.tex",
      "\\documentclass{article}\\begin{document}\n" +
        dense +
        "\n\nAnother result $y$.\n\\end{document}",
    ],
  ]);
  const counts = [];
  const result = await translateLatexProject(
    files,
    {
      cacheKey: "dense",
      translate: async (text) => {
        const { segments } = JSON.parse(text);
        counts.push(segments.length);
        return translate(text);
      },
    },
    { read: async () => undefined, write: async () => {} },
    hash,
    () => {},
    () => {},
  );
  assert.deepEqual(counts, [1, 1]);
  assert.equal(result.requested, 2);
  assert.ok(result.files.get("main.tex").includes("$x_59$"));
});

test("API contract handles both protocols, rejects truncated output and keeps credentials out of bodies", () => {
  const config = {
    baseUrl: "https://example.test/v1/",
    model: "model-name",
    protocol: "chat-completions",
    key: "secret",
  };
  const chat = modelRequest(config, "text");
  assert.throws(
    () => modelRequest({ ...config, baseUrl: "" }, "text"),
    /API 基础地址/,
  );
  assert.equal(chat.url, "https://example.test/v1/chat/completions");
  assert.ok(
    modelRequest(
      config,
      "text",
      "Copy tokens exactly",
    ).body.messages[0].content.endsWith("Copy tokens exactly"),
  );
  assert.ok(!JSON.stringify(chat).includes("secret"));
  assert.equal(
    modelResponse(config.protocol, {
      choices: [{ finish_reason: "stop", message: { content: "译文" } }],
    }),
    "译文",
  );
  assert.throws(
    () =>
      modelResponse(config.protocol, {
        choices: [{ finish_reason: "length", message: { content: "译文" } }],
      }),
    /截断/,
  );
  config.protocol = "responses";
  assert.ok(
    modelRequest(
      config,
      "text",
      "Copy tokens exactly",
    ).body.instructions.endsWith("Copy tokens exactly"),
  );
  assert.equal(
    modelRequest(config, "text").url,
    "https://example.test/v1/responses",
  );
  assert.equal(
    modelResponse(config.protocol, {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "译文" }] },
      ],
    }),
    "译文",
  );
  assert.throws(
    () => modelResponse(config.protocol, { status: "incomplete", output: [] }),
    /未完成/,
  );
  assert.throws(
    () => modelRequest({ ...config, baseUrl: "http://remote.test/v1" }, "text"),
    /HTTPS/,
  );
  assert.throws(
    () =>
      modelRequest(
        { ...config, baseUrl: "https://user:secret@example.test/v1" },
        "text",
      ),
    /密钥/,
  );
});
