import { getPref } from "../utils/prefs";
import { readSourceArchive } from "../utils/sourceArchive";
import { parseArxivId } from "../utils/arxivId";
import {
  modelRequest,
  modelResponse,
  type ModelConfiguration,
} from "./latex/api";
import { translateLatexProject } from "./latex/pipeline";
import { ensurePortableTex } from "./latex/portableTex";
import { TaskQueue } from "../utils/taskQueue";
import { modelRequestFailure, retryModelRequest } from "./latex/request";
import {
  assertResolvedReferences,
  prepareBundledBibliography,
  prepareTectonicSource,
} from "./latex/tectonicSource";
import {
  addChineseSupport,
  findMainFile,
  stripLatexComments,
} from "./latex/source";
import { prepareChineseCompilation } from "./latex/chineseCompilation";
import {
  findLocalTex,
  texArguments,
  texEnvironment,
  texFailure,
  windowsTexDirectories,
  type TexCompiler,
} from "./latex/texCompiler";
import {
  compileWithTexDependencies,
  ensureManagedTex,
  findManagedTex,
  installTexDependency,
  updateManagedTex,
  type TexToolRunner,
} from "./latex/managedTex";

const KEY_ORIGIN = "chrome://hjfyarxiv";
const KEY_REALM = "lightweight-api";

export async function configureLightweightKey(win: Window) {
  const value = { value: "" };
  if (
    !Services.prompt.promptPassword(
      win as any,
      "轻量翻译后端",
      "输入 API 密钥；留空并确认可删除已保存密钥。密钥保存到 Zotero 密码管理器。",
      value,
    )
  )
    return;
  const previous = Services.logins.findLogins(
    KEY_ORIGIN,
    null as any,
    KEY_REALM,
  );
  if (value.value) {
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo,
    );
    login.init(
      KEY_ORIGIN,
      null as any,
      KEY_REALM,
      "api-key",
      value.value,
      "",
      "",
    );
    if (previous[0]) Services.logins.modifyLogin(previous[0], login);
    else await Services.logins.addLoginAsync(login);
    for (const duplicate of previous.slice(1))
      Services.logins.removeLogin(duplicate);
  } else for (const login of previous) Services.logins.removeLogin(login);
  value.value = "";
  Services.prompt.alert(win as any, "轻量翻译后端", "密钥设置已更新。");
}

export function lightweightConfiguration(): ModelConfiguration {
  return {
    baseUrl: String(getPref("lightweight.baseUrl") || "").trim(),
    model: String(getPref("lightweight.model") || "").trim(),
    protocol: String(getPref("lightweight.protocol") || "chat-completions"),
    key:
      Services.logins.findLogins(KEY_ORIGIN, null as any, KEY_REALM)[0]
        ?.password || "",
  };
}

export class LightweightTranslation {
  private static generation = 0;
  private static requests = new Set<XMLHttpRequest>();
  private static processes = new Set<any>();
  private static localProcesses = new Set<any>();
  private static compilerQueue = new TaskQueue(1);
  private static completed = new Map<string, string>();

  static async cleanup(output: string) {
    const job = this.completed.get(output);
    if (!job) return;
    await IOUtils.remove(job, { recursive: true, ignoreAbsent: true });
    this.completed.delete(output);
  }

  static async cancelAll() {
    this.generation++;
    for (const request of this.requests) request.abort();
    await Promise.all([...this.processes].map((process) => this.stop(process)));
  }

  private static async stop(process: any) {
    if (!Zotero.isWin || !this.localProcesses.has(process)) {
      await process.kill();
      return;
    }
    // latexmk starts TeX/bibliography children; stop the complete tree as the
    // desktop adapter does, so cancellation cannot leave a compiler running.
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

  private static async runCompiler(
    command: string,
    args: string[],
    workdir: string,
    cache: string,
    log: (text: string) => void,
    check: () => void,
    environment: Record<string, string> = {},
  ) {
    return this.compilerQueue.run(workdir, () =>
      this.compile(command, args, workdir, cache, log, check, environment),
    );
  }

  private static async compile(
    command: string,
    args: string[],
    workdir: string,
    cache: string,
    log: (text: string) => void,
    check: () => void,
    environment: Record<string, string> = {},
  ) {
    check();
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    const local = /^latexmk(?:\.exe)?$/i.test(PathUtils.filename(command)!);
    const dependency =
      !local && !/^tectonic(?:\.exe)?$/i.test(PathUtils.filename(command)!);
    const process = await Subprocess.call({
      command,
      arguments: args,
      workdir,
      environment: {
        TECTONIC_CACHE_DIR: cache,
        TECTONIC_UNTRUSTED_MODE: "1",
        NoDefaultCurrentDirectoryInExePath: "1",
        ...environment,
      },
      environmentAppend: true,
      stderr: "pipe",
    });
    this.processes.add(process);
    if (local || dependency) this.localProcesses.add(process);
    let exited = false;
    let output = "";
    const read = async (pipe: any) => {
      for (;;) {
        const chunk = await pipe.readString();
        if (!chunk) return;
        output = (output + chunk).slice(-16000);
        log(
          `[${dependency ? "TeX 依赖" : local ? "本机 TeX" : "便携 TeX"}] ${chunk}`,
        );
      }
    };
    try {
      await process.stdin.close();
      const [, , result] = await Promise.all([
        read(process.stdout),
        read(process.stderr),
        process.wait().then((result: { exitCode: number }) => {
          exited = true;
          return result;
        }),
      ]);
      check();
      if (result.exitCode !== 0)
        throw new Error(
          dependency
            ? `自动 TeX 依赖处理失败。\n${output.slice(-4000)}`
            : texFailure(output, local),
        );
      return output;
    } finally {
      try {
        if (!exited) await this.stop(process);
      } finally {
        this.processes.delete(process);
        this.localProcesses.delete(process);
      }
    }
  }

  static async translate(
    arxivId: string,
    update: (text: string) => void,
    log: (text: string) => void = () => {},
  ): Promise<string> {
    if (parseArxivId(arxivId) !== arxivId) throw new Error("无效的 arXiv ID。");
    const generation = this.generation;
    const check = () => {
      if (generation !== this.generation) throw new Error("翻译任务已取消。");
    };
    const config = lightweightConfiguration();
    modelRequest(config, "配置检查");
    const root = PathUtils.join(PathUtils.profileDir, "hjfy-lightweight");
    const job = PathUtils.join(
      root,
      "tasks",
      `${Date.now()}-${Zotero.Utilities.randomString()}`,
    );
    const project = PathUtils.join(job, "translated");
    const cache = PathUtils.join(root, "translations");
    const texCache = PathUtils.join(root, "tex-cache");
    for (const path of [project, cache, texCache])
      await IOUtils.makeDirectory(path, { createAncestors: true });
    update(`轻量后端诊断目录：${job}`);
    try {
      // An explicit Tectonic path remains an explicit choice of that engine.
      let compiler: TexCompiler | undefined;
      if (!String(getPref("lightweight.tectonicPath") || "").trim()) {
        const { Subprocess } = ChromeUtils.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        );
        compiler = await findLocalTex(
          (name) => Subprocess.pathSearch(name),
          windowsTexDirectories,
        );
        compiler ??= await findManagedTex();
      }
      compiler ??= {
        command: await ensurePortableTex(update),
        kind: "portable",
      };
      log(
        compiler.kind === "local"
          ? `使用本机 TeX（与桌面端相同的已安装发行版）：${compiler.command}`
          : compiler.kind === "managed"
            ? `复用自动配置的 TeX 环境：${compiler.command}`
            : `使用便携 TeX：${compiler.command}`,
      );
      const runTool: TexToolRunner = (command, args, workdir, environment) =>
        this.runCompiler(
          command,
          args,
          workdir,
          texCache,
          log,
          check,
          environment,
        );
      const compileProject = (
        main: string,
        output: string,
        preflight = false,
      ) =>
        compileWithTexDependencies(
          compiler!,
          (selected) =>
            this.runCompiler(
              selected.command,
              texArguments(selected, main, output, preflight),
              PathUtils.parent(main)!,
              texCache,
              log,
              check,
              texEnvironment(selected),
            ),
          async () => {
            update("检测到缺失或过旧的 TeX 依赖，正在自动补齐兼容环境…");
            const selected = await ensureManagedTex(runTool, update, check);
            log(`自动使用独立 TeX 环境：${selected.command}`);
            return selected;
          },
          (selected, file) =>
            installTexDependency(selected, file, runTool, update, check),
          check,
          (selected) => updateManagedTex(selected, runTool, update, check),
        );
      check();
      update("正在下载 arXiv 源码…");
      const archive = PathUtils.join(job, "source.download");
      await Zotero.File.download(`https://arxiv.org/src/${arxivId}`, archive);
      check();
      if (((await IOUtils.stat(archive)).size || 0) > 200 * 1024 * 1024)
        throw new Error("arXiv 源码超过 200 MiB。");
      const entries = readSourceArchive(await IOUtils.read(archive));
      const files = new Map<string, string>();
      for (const entry of entries)
        if (/\.tex$/i.test(entry.path)) {
          try {
            files.set(
              entry.path,
              new TextDecoder("utf-8", { fatal: true }).decode(entry.data),
            );
          } catch {
            throw new Error(`轻量后端暂只支持 UTF-8 源码：${entry.path}`);
          }
        }
      const writeProject = async (
        sourceFiles: Map<string, string>,
        mainFile: string,
        destination: string,
      ) => {
        const bibliographyPath = mainFile.replace(/\.tex$/i, ".bbl");
        const bibliographyEntry = entries.find(
          (entry) =>
            entry.path.toLowerCase() === bibliographyPath.toLowerCase(),
        );
        // arXiv often supplies a finished .bbl without its source .bib. Running
        // BibTeX in that case overwrites the valid bibliography with an empty one.
        // Only traditional BibTeX bibliographies can be input directly; biblatex
        // .bbl files use a different protocol and must not take this path.
        const bundledBibliography =
          bibliographyEntry &&
          /\\begin\s*\{thebibliography\}/.test(
            stripLatexComments(
              new TextDecoder().decode(bibliographyEntry.data),
            ),
          );
        for (const entry of entries) {
          const target = PathUtils.join(destination, ...entry.path.split("/"));
          await IOUtils.makeDirectory(PathUtils.parent(target)!, {
            createAncestors: true,
          });
          if (sourceFiles.has(entry.path)) {
            // Compile a compatible copy without changing source extraction or
            // translation cache keys. Apply to included TeX files as well.
            const prepared = prepareTectonicSource(
              sourceFiles.get(entry.path)!,
            );
            if (prepared.lines.length)
              log(
                `[XeTeX 兼容] ${entry.path} 第 ${prepared.lines.join("、")} 行：跳过仅适用于 pdfTeX 的指令。`,
              );
            const bibliography = bundledBibliography
              ? prepareBundledBibliography(prepared.source)
              : { source: prepared.source, replacements: 0 };
            if (bibliography.replacements)
              log(
                `[文献兼容] ${entry.path}：使用归档自带的 ${bibliographyPath}，保留原文献条目与引用键，避免 BibTeX 覆盖。`,
              );
            await IOUtils.writeUTF8(
              target,
              entry.path === mainFile
                ? prepareChineseCompilation(
                    addChineseSupport(bibliography.source),
                  )
                : bibliography.source,
            );
          } else await IOUtils.write(target, entry.data);
        }
      };
      const configuredMain = String(
        getPref("lightweight.mainFile") || "",
      ).trim();
      const mainFile = findMainFile(files, configuredMain);
      const bibliographyEntry = entries.find(
        (entry) =>
          entry.path.toLowerCase() ===
          mainFile.replace(/\.tex$/i, ".bbl").toLowerCase(),
      );
      compiler.bundledBibliography =
        !!bibliographyEntry &&
        /\\begin\s*\{thebibliography\}/.test(
          stripLatexComments(new TextDecoder().decode(bibliographyEntry.data)),
        );
      const preflightProject = PathUtils.join(job, "preflight-source");
      const preflightOutput = PathUtils.join(job, "preflight-output");
      await IOUtils.makeDirectory(preflightOutput);
      await writeProject(files, mainFile, preflightProject);
      const preflightMain = PathUtils.join(
        preflightProject,
        ...mainFile.split("/"),
      );
      update("翻译前检查整篇论文的 TeX 依赖与中文兼容性…");
      try {
        await compileProject(preflightMain, preflightOutput, true);
      } catch (error) {
        check();
        throw new Error(
          `翻译前全文编译预检未通过，尚未调用模型。${error instanceof Error ? error.message : String(error)}`,
        );
      }
      update("正在解析 LaTeX 正文…");
      const hash = async (value: string) => {
        const crypto = Cc["@mozilla.org/security/hash;1"].createInstance(
          Ci.nsICryptoHash,
        );
        crypto.init(crypto.SHA256!);
        const bytes = new TextEncoder().encode(value);
        crypto.update(bytes, bytes.length);
        return Array.from(crypto.finish(false), (char) =>
          char.charCodeAt(0).toString(16).padStart(2, "0"),
        ).join("");
      };
      let httpRequests = 0;
      const result = await translateLatexProject(
        files,
        {
          cacheKey: JSON.stringify([
            config.baseUrl,
            config.protocol,
            config.model,
          ]),
          diagnostic: async (record) => {
            const directory = PathUtils.join(job, "diagnostics");
            await IOUtils.makeDirectory(directory, { ignoreExisting: true });
            await IOUtils.writeJSON(
              PathUtils.join(
                directory,
                `batch-${record.batch}-attempt-${record.attempt}.json`,
              ),
              record,
            );
          },
          translate: async (text, feedback) => {
            check();
            const request = modelRequest(config, text, feedback);
            const response = await retryModelRequest(
              async () => {
                let xhr: XMLHttpRequest | undefined;
                try {
                  httpRequests++;
                  return await Zotero.HTTP.request("POST", request.url, {
                    body: JSON.stringify(request.body),
                    headers: {
                      "Content-Type": "application/json",
                      ...(config.key
                        ? { Authorization: `Bearer ${config.key}` }
                        : {}),
                    },
                    timeout: 120000,
                    errorDelayMax: 0,
                    logBodyLength: 0,
                    followRedirects: false,
                    requestObserver: (request: XMLHttpRequest) => {
                      xhr = request;
                      this.requests.add(request);
                    },
                  });
                } catch (error) {
                  check();
                  // Read only the status and Retry-After header. Never log the
                  // exception text, full HTTP response or authorization header.
                  const status = Number(
                    (error as { status?: number })?.status || xhr?.status || 0,
                  );
                  let retryAfter: string | null = null;
                  try {
                    retryAfter = xhr?.getResponseHeader("Retry-After") || null;
                  } catch {
                    // Network failures may not expose response headers.
                  }
                  throw modelRequestFailure(status, retryAfter);
                } finally {
                  if (xhr) this.requests.delete(xhr);
                }
              },
              async (milliseconds) => {
                // Keep plugin shutdown responsive during backoff.
                while (milliseconds > 0) {
                  check();
                  const step = Math.min(milliseconds, 250);
                  await Zotero.Promise.delay(step);
                  milliseconds -= step;
                }
                check();
              },
              check,
              update,
            );
            let data;
            try {
              data = JSON.parse(response.responseText || "");
            } catch {
              throw new Error("模型服务未返回有效的 API JSON。");
            }
            return modelResponse(config.protocol, data);
          },
        },
        {
          read: async (key) => {
            const path = PathUtils.join(cache, `${key}.txt`);
            return (await IOUtils.exists(path))
              ? IOUtils.readUTF8(path)
              : undefined;
          },
          write: async (key, value) => {
            const path = PathUtils.join(cache, `${key}.txt`);
            const temporary = `${path}.${Zotero.Utilities.randomString()}.tmp`;
            try {
              await IOUtils.writeUTF8(path, value, {
                tmpPath: temporary,
                flush: true,
              });
            } finally {
              await IOUtils.remove(temporary, { ignoreAbsent: true }).catch(
                () => {},
              );
            }
          },
        },
        hash,
        update,
        check,
        configuredMain,
      );
      check();
      await writeProject(result.files, result.main, project);
      const main = PathUtils.join(project, ...result.main.split("/"));
      const outputDirectory = PathUtils.join(job, "pdf");
      await IOUtils.makeDirectory(outputDirectory);
      update(
        `正在使用${compiler.kind === "portable" ? "便携" : compiler.kind === "managed" ? "自动配置的" : "本机"} TeX 编译译文 PDF…`,
      );
      await compileProject(main, outputDirectory);
      await IOUtils.readUTF8(
        PathUtils.join(
          outputDirectory,
          PathUtils.filename(main)!.replace(/\.tex$/i, ".log"),
        ),
      ).then(assertResolvedReferences);
      const output = PathUtils.join(
        outputDirectory,
        PathUtils.filename(main)!.replace(/\.tex$/i, ".pdf"),
      );
      if (
        !(await IOUtils.exists(output)) ||
        String.fromCharCode(
          ...(await IOUtils.read(output, { maxBytes: 5 })),
        ) !== "%PDF-"
      )
        throw new Error("TeX 未生成有效的 PDF。");
      await IOUtils.writeJSON(PathUtils.join(job, "result.json"), {
        arxivId,
        main: result.main,
        requested: result.requested,
        cacheHits: result.cacheHits,
        requests: httpRequests,
        output,
        backend: "lightweight-v1",
        compiler: compiler.kind,
      });
      log(
        `翻译 ${result.requested} 段，缓存 ${result.cacheHits} 段，模型请求 ${httpRequests} 次；译文源码保存在 ${project}`,
      );
      this.completed.set(output, job);
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await IOUtils.writeJSON(PathUtils.join(job, "error.json"), {
        error: message,
      }).catch(() => {});
      throw new Error(`${message}\n诊断目录：${job}`);
    } finally {
      config.key = "";
    }
  }
}
