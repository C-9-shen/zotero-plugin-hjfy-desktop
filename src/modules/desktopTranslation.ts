import { prepareDesktopPdfTask, prepareDesktopTask } from "./desktopRuntime";
import { parseArxivId } from "../utils/arxivId";

interface DesktopEvent {
  type: string;
  message?: string | { text?: string };
  outcome?: string;
  output_pdf?: string;
  file?: string;
  content?: { translated?: number };
  result?: {
    output_pdf?: string;
    translation?: {
      fallback_originals?: number;
      requested?: number;
      translated?: number;
      cache_hits?: number;
    };
  };
}

export class DesktopTranslation {
  private static active = new Set<any>();
  private static generation = 0;
  private static completed = new Map<string, string>();

  static async cleanup(output: string) {
    const job = this.completed.get(output);
    if (!job) return;
    // Only remove the task directory recorded by this backend after import.
    await IOUtils.remove(job, { recursive: true, ignoreAbsent: true });
    this.completed.delete(output);
  }

  private static prepareTask = prepareDesktopTask;
  private static preparePdfTask = prepareDesktopPdfTask;

  private static async stop(process: any) {
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    const killer = await Subprocess.call({
      command: PathUtils.join(
        Services.env.get("SystemRoot"),
        "System32",
        "taskkill.exe",
      ),
      arguments: ["/PID", String(process.pid), "/T", "/F"],
    });
    await killer.wait();
  }

  static async cancelAll() {
    this.generation++;
    await Promise.all([...this.active].map((process) => this.stop(process)));
  }

  static async translate(
    arxivId: string,
    update: (text: string) => void,
    log: (text: string) => void = () => {},
  ): Promise<string> {
    if (parseArxivId(arxivId) !== arxivId) throw new Error("无效的 arXiv ID。");
    return this.run(
      (job, runtime) => this.prepareTask(arxivId, job, runtime, update),
      update,
      log,
    );
  }

  static async translatePdf(
    input: string,
    update: (text: string) => void,
    log: (text: string) => void = () => {},
  ): Promise<string> {
    return this.run(
      (job, runtime) => this.preparePdfTask(input, job, runtime, update),
      update,
      log,
    );
  }

  private static async run(
    prepare: (
      job: string,
      runtime: string,
    ) => Promise<
      Awaited<ReturnType<typeof prepareDesktopTask>> & { outputPdf?: string }
    >,
    update: (text: string) => void,
    log: (text: string) => void,
  ): Promise<string> {
    if (!Zotero.isWin) {
      throw new Error("桌面端接入目前仅支持 Windows。");
    }
    const generation = this.generation;
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    const root = PathUtils.join(PathUtils.profileDir, "hjfy-desktop");
    const job = PathUtils.join(
      root,
      "tasks",
      `${Date.now()}-${Zotero.Utilities.randomString()}`,
    );
    await IOUtils.makeDirectory(job, { createAncestors: true });
    update(`诊断目录：${job}`);
    const { outputPdf, ...options } = await prepare(
      job,
      PathUtils.join(root, "runtime"),
    );
    let process: any;
    try {
      if (generation !== this.generation) throw new Error("翻译任务已取消。");
      process = await Subprocess.call(options);
    } finally {
      options.environment.HJFY_PLUGIN_API_KEY = "";
    }
    this.active.add(process);
    let terminal: DesktopEvent | undefined;
    let pdfContent: DesktopEvent["content"];
    let bridgeError = "";
    let stderr = "";
    let exited = false;
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line) as DesktopEvent;
      if (event.type === "bridge_error") bridgeError = String(event.message);
      if (event.type === "run_finished") terminal = event;
      if (outputPdf && event.type === "document_finished")
        pdfContent = event.content;
      const text =
        typeof event.message === "string" ? event.message : event.message?.text;
      if (text) update(event.file ? `${text}（${event.file}）` : text);
    };
    try {
      // The PDF engine uses stdin for cancellation and treats EOF as cancel.
      if (!outputPdf) await process.stdin.close();
      const readEvents = async () => {
        let pending = "";
        while (true) {
          const chunk = await process.stdout.readString();
          if (!chunk) break;
          pending += chunk;
          let newline: number;
          while ((newline = pending.indexOf("\n")) >= 0) {
            handleLine(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
          }
          if (pending.length > 1024 * 1024)
            throw new Error("本地引擎返回了无效的进度数据。");
        }
        if (pending.trim()) handleLine(pending);
      };
      const readErrors = async () => {
        while (true) {
          const chunk = await process.stderr.readString();
          if (!chunk) break;
          stderr = (stderr + chunk).slice(-4000);
          log(`[引擎 stderr] ${chunk}`);
        }
      };
      const [, , result] = await Promise.all([
        readEvents(),
        readErrors(),
        process.wait().then((result: { exitCode: number }) => {
          exited = true;
          return result;
        }),
      ]);
      await IOUtils.writeUTF8(PathUtils.join(job, "engine-stderr.log"), stderr);
      if (terminal)
        await IOUtils.writeJSON(PathUtils.join(job, "result.json"), terminal);
      const stats = terminal?.result?.translation;
      if (stats) {
        log(
          `翻译统计：请求 ${stats.requested ?? "未知"} 段，翻译 ${stats.translated ?? "未知"} 段，缓存 ${stats.cache_hits ?? 0} 段，回退原文 ${stats.fallback_originals ?? 0} 段。`,
        );
      }
      if (result.exitCode !== 0 || terminal?.outcome !== "succeeded") {
        throw new Error(
          bridgeError ||
            `本地翻译失败。诊断目录：${job}${stderr ? `；${stderr}` : ""}`,
        );
      }
      if ((terminal.result?.translation?.fallback_originals || 0) > 0) {
        throw new Error(
          `部分文本翻译失败并回退为原文（${stats!.fallback_originals} 段），未导入不完整译文。诊断目录：${job}`,
        );
      }
      if (pdfContent?.translated === 0) {
        throw new Error(`PDF 引擎未翻译任何内容。诊断目录：${job}`);
      }
      const output =
        outputPdf || terminal.output_pdf || terminal.result?.output_pdf;
      if (
        !output ||
        !PathUtils.isAbsolute(output) ||
        !output.toLowerCase().endsWith(".pdf") ||
        !(await IOUtils.exists(output))
      ) {
        throw new Error(`引擎未生成可用的翻译 PDF。诊断目录：${job}`);
      }
      const header = await IOUtils.read(output, { maxBytes: 5 });
      if (String.fromCharCode(...header) !== "%PDF-")
        throw new Error("翻译结果不是有效的 PDF。");
      this.completed.set(output, job);
      return output;
    } finally {
      this.active.delete(process);
      // Also terminate descendants if parsing failed or the plugin was shut down.
      try {
        if (!exited) await this.stop(process);
      } finally {
        if (outputPdf) await process.stdin.close().catch(() => {});
      }
    }
  }
}
