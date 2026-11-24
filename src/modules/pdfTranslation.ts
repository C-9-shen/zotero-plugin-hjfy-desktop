import { getPref } from "../utils/prefs";
import { modelRequest } from "./latex/api";
import { lightweightConfiguration } from "./lightweightTranslation";

// BabelDOC 0.7.1 accepts the key as a CLI option, but does not read it from
// the environment. Build its Python argv in-process rather than exposing it
// on the OS command line or writing a credentials file.
const BABELDOC_ENTRY = `import os, sys
from babeldoc.main import cli
sys.argv[0] = "babeldoc"
sys.argv += ["--openai-api-key", os.environ.pop("HJFY_PDF_API_KEY")]
cli()`;

export class PdfTranslation {
  private static active = new Set<any>();
  private static completed = new Map<string, string>();
  private static generation = 0;

  static async cancelAll() {
    this.generation++;
    await Promise.allSettled([...this.active].map((process) => process.kill()));
  }

  static async cleanup(output: string) {
    const job = this.completed.get(output);
    if (!job) return;
    await IOUtils.remove(job, { recursive: true, ignoreAbsent: true });
    this.completed.delete(output);
  }

  static async translate(
    input: string,
    update: (text: string) => void,
    log: (text: string) => void = () => {},
  ) {
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation)
        throw new Error("PDF 翻译任务已取消。");
    };
    const python = String(getPref("pdf.pythonPath") || "").trim();
    if (
      !python ||
      !PathUtils.isAbsolute(python) ||
      !(await IOUtils.exists(python))
    )
      throw new Error(
        "请在 PDF 翻译设置中填写已安装 BabelDOC 的 Python 绝对路径。",
      );
    const config = lightweightConfiguration();
    if (config.protocol !== "chat-completions")
      throw new Error("独立 PDF 后端需要 Chat Completions 兼容接口。");
    modelRequest(config, "配置检查");
    const job = PathUtils.join(
      PathUtils.profileDir,
      "hjfy-pdf",
      "tasks",
      `${Date.now()}-${Zotero.Utilities.randomString()}`,
    );
    await IOUtils.makeDirectory(job, { createAncestors: true });
    update(`独立 PDF 后端诊断目录：${job}`);
    const source = PathUtils.join(job, "source.pdf");
    await IOUtils.copy(input, source);
    const output = PathUtils.join(job, "source.no_watermark.zh.mono.pdf");
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    const environment = {
      HJFY_PDF_API_KEY: config.key || "local-no-key",
      NoDefaultCurrentDirectoryInExePath: "1",
    };
    check();
    update("正在使用 BabelDOC 翻译 PDF，首次使用可能下载排版模型和字体…");
    const process = await Subprocess.call({
      command: python,
      arguments: [
        "-I",
        "-X",
        "utf8",
        "-u",
        "-c",
        BABELDOC_ENTRY,
        "--files",
        source,
        "--output",
        job,
        "--working-dir",
        job,
        "--lang-in",
        "en",
        "--lang-out",
        "zh",
        "--no-dual",
        "--no-watermark",
        "--no-auto-extract-glossary",
        "--qps",
        "2",
        "--openai",
        "--openai-base-url",
        config.baseUrl.replace(/\/+$/, ""),
        "--openai-model",
        config.model,
      ],
      workdir: job,
      environment,
      environmentAppend: true,
      stderr: "pipe",
    }).finally(() => {
      environment.HJFY_PDF_API_KEY = "";
    });
    this.active.add(process);
    let exited = false;
    const read = async (pipe: { readString(): Promise<string> }) => {
      let tail = "";
      for (;;) {
        const chunk = await pipe.readString();
        if (!chunk) break;
        tail = (tail + chunk).slice(-16000 - config.key.length);
      }
      return config.key ? tail.replaceAll(config.key, "[redacted]") : tail;
    };
    try {
      check();
      await process.stdin.close();
      const [stdout, stderr, result] = await Promise.all([
        read(process.stdout),
        read(process.stderr),
        process.wait().then((result: { exitCode: number }) => {
          exited = true;
          return result;
        }),
      ]);
      check();
      const diagnostics = [stdout, stderr].filter(Boolean).join("\n");
      await IOUtils.writeUTF8(PathUtils.join(job, "engine.log"), diagnostics);
      if (diagnostics) log(diagnostics.slice(-1500));
      if (result.exitCode !== 0 || !(await IOUtils.exists(output))) {
        if (/No module named ['"]babeldoc/.test(diagnostics))
          throw new Error(
            "所选 Python 未安装 BabelDOC，请安装 BabelDOC 0.7.1 后重试。",
          );
        throw new Error(`BabelDOC 未生成译文 PDF。诊断目录：${job}`);
      }
      if (
        String.fromCharCode(
          ...(await IOUtils.read(output, { maxBytes: 5 })),
        ) !== "%PDF-"
      )
        throw new Error(`BabelDOC 输出不是有效的 PDF。诊断目录：${job}`);
      this.completed.set(output, job);
      return output;
    } finally {
      try {
        if (!exited) await process.kill();
      } finally {
        this.active.delete(process);
      }
    }
  }
}
