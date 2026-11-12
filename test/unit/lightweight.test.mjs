import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";

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
const translate = (text) =>
  text
    .split(/(\[\[HJFY_\d+\]\])/)
    .map((part) => (part.startsWith("[[HJFY_") ? part : chinese(part)))
    .join("");
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

test("LaTeX validation rejects token corruption, introduced syntax and untranslated output", () => {
  const unit = planLatex("A result $x$ is useful.", true).units[0];
  assert.throws(() => restoreLatex(unit, "结果很有用。"), /保护标记/);
  assert.throws(
    () => restoreLatex(unit, "结果 [[HJFY_0]] \\input{evil}"),
    /TeX/,
  );
  assert.throws(
    () => restoreLatex(unit, "结果 [[HJFY_0]][[HJFY_0]]"),
    /保护标记/,
  );
  assert.throws(() => restoreLatex(unit, unit.text), /中文/);
  assert.throws(() => planLatex("An unclosed $formula", true), /公式未闭合/);
  assert.throws(() => planLatex(String.raw`\input chapter`, true), /花括号/);
  assert.equal(
    restoreLatex(unit, "结果 [[HJFY_0]] 很有用。"),
    "结果 $x$ 很有用。",
  );
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

test("standalone scientific acronyms can remain unchanged while English prose is rejected", () => {
  for (const text of ["LIBERO.", "CALVIN.", " MSE ", "DINOv2"]) {
    const unit = planLatex(text, true).units[0];
    if (text === "DINOv2") {
      assert.throws(() => restoreLatex(unit, text), /中文/);
    } else {
      assert.equal(restoreLatex(unit, text), text);
      assert.throws(() => restoreLatex(unit, "OTHER"), /中文/);
    }
  }
  for (const text of [
    "Introduction",
    "or",
    "A useful result.",
    "THE RESULT.",
  ]) {
    const unit = planLatex(text, true).units[0];
    assert.throws(() => restoreLatex(unit, text), /中文/);
  }
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
  assert.equal(calls, 4);
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
  assert.equal(calls, 4);
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

test("rerunning a failed project reuses successful segments without another model request", async () => {
  const files = new Map([
    [
      "main.tex",
      String.raw`\documentclass{article}
\begin{document}
First useful result.

Second useful result.

Last useful result.
\end{document}`,
    ],
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
      return fail && text.includes("Last useful") ? text : translate(text);
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
  await assert.rejects(run(), /main.tex 第 3 段：模型未返回中文译文/);
  assert.equal(values.size, 2);
  fail = false;
  calls.length = 0;
  const result = await run();
  assert.equal(result.cacheHits, 2);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes("Last useful"));
  assert.equal(values.size, 3);
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

test("damaged marker replies fall back to prose spans with exact TeX restoration and cache reuse", async () => {
  const body = String.raw`Both cameras use transitions ($\delta=8$).
Let $I_u$ denote the frame in observation $o_u$.
A code group from $(I_u,I_{u+8})$ is stored at $u$.
For an anchor $t$ with horizon $H=8$, retrieve $u=t,\ldots,t+7$:
\begin{equation}c_{t+j}=E(I_{t+j},I_{t+j+8}).\label{eq:temporal}\end{equation}
The final group uses $I_{t+15}$ and actions at $t,\ldots,t+7$.
Future supervision uses $t+8$.`;
  const source = `\\documentclass{article}\\begin{document}${body}\\end{document}`;
  const files = new Map([["main.tex", source]]);
  const unit = planLatex(source).units[0];
  assert.equal(unit.protected.length, 12);
  for (const damage of [
    (text) => text.replace("[[HJFY_7]]", ""),
    (text) => text.replace("[[HJFY_0]]", "[[HJFY_1]]"),
    (text) =>
      text.replace(
        /\[\[HJFY_([01])\]\]/g,
        (_, index) => `[[HJFY_${1 - Number(index)}]]`,
      ),
    (text) => text + "[[HJFY_99]]",
  ]) {
    const values = new Map();
    const calls = [];
    const updates = [];
    const provider = {
      cacheKey: "marker-fallback",
      translate: async (text) => {
        calls.push(text);
        return text.includes("[[HJFY_")
          ? damage(translate(text))
          : translate(text);
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
        files,
        provider,
        cache,
        hash,
        (message) => updates.push(message),
        () => {},
      );
    const first = await run();
    const output = first.files.get("main.tex");
    assert.equal(calls.filter((text) => text.includes("[[HJFY_")).length, 2);
    assert.ok(calls.length > 2);
    for (const literal of unit.protected)
      assert.ok(output.includes(literal), literal);
    assert.deepEqual(planLatex(output).units, []);
    const cached = values.get(
      await hash(
        JSON.stringify([
          "hjfy-lite-v1",
          provider.cacheKey,
          unit.text,
          unit.protected,
        ]),
      ),
    );
    assert.equal(
      restoreLatex(unit, cached),
      output.slice(
        output.indexOf("\\begin{document}") + 16,
        output.indexOf("\\end{document}"),
      ),
    );
    assert.ok(updates.some((message) => message.includes("分段翻译")));
    const count = calls.length;
    const second = await run();
    assert.equal(second.cacheHits, 1);
    assert.equal(calls.length, count);
    assert.deepEqual(first.files, second.files);
  }
});

test("prose fallback rejects injected syntax and stops requests when cancelled", async () => {
  const files = new Map([
    [
      "main.tex",
      String.raw`\documentclass{article}\begin{document}An observation $x$ gives a result.\end{document}`,
    ],
  ]);
  for (const mode of ["syntax", "cancel"]) {
    const values = new Map();
    let calls = 0;
    let cancelled = false;
    await assert.rejects(
      translateLatexProject(
        files,
        {
          cacheKey: "bad-fallback",
          translate: async (text) => {
            calls++;
            if (text.includes("[[HJFY_")) return "丢失标记";
            if (mode === "cancel") cancelled = true;
            return String.raw`译文\input{evil}`;
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
          if (cancelled) throw new Error("cancelled");
        },
      ),
      mode === "cancel" ? /cancelled/ : /TeX/,
    );
    assert.equal(calls, mode === "cancel" ? 3 : 4);
    assert.equal(values.size, 0);
  }
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
