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

  static async cancelAll() {
    this.generation++;
    for (const request of this.requests) request.abort();
    await Promise.all([...this.processes].map((process) => process.kill()));
  }

  private static async runCompiler(
    command: string,
    args: string[],
    workdir: string,
    cache: string,
    log: (text: string) => void,
    check: () => void,
  ) {
    check();
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    const process = await Subprocess.call({
      command,
      arguments: args,
      workdir,
      environment: { TECTONIC_CACHE_DIR: cache, TECTONIC_UNTRUSTED_MODE: "1" },
      environmentAppend: true,
      stderr: "pipe",
    });
    this.processes.add(process);
    let exited = false;
    let output = "";
    const read = async (pipe: any) => {
      for (;;) {
        const chunk = await pipe.readString();
        if (!chunk) return;
        output = (output + chunk).slice(-16000);
        log(`[便携 TeX] ${chunk}`);
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
          `便携 TeX 编译失败。首用需联网下载宏包；部分模板或外部工具不受支持。${output.slice(-2000)}`,
        );
    } finally {
      this.processes.delete(process);
      if (!exited) await process.kill();
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
      const compiler = await ensurePortableTex(update);
      check();
      // Download/validate the CJK format before any potentially paid API calls.
      const probe = PathUtils.join(job, "tex-probe.tex");
      await IOUtils.writeUTF8(
        probe,
        "\\documentclass{article}\n\\usepackage[UTF8,fontset=fandol]{ctex}\n\\begin{document}中文测试 $x^2$\\end{document}\n",
      );
      update("检查便携 TeX 与中文宏包（首次会下载并缓存资源）…");
      await this.runCompiler(
        compiler,
        [
          "--untrusted",
          "--outfmt",
          "xdv",
          "--keep-logs",
          "--outdir",
          job,
          probe,
        ],
        job,
        texCache,
        log,
        check,
      );
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
      const result = await translateLatexProject(
        files,
        {
          cacheKey: JSON.stringify([
            config.baseUrl,
            config.protocol,
            config.model,
          ]),
          translate: async (text, feedback) => {
            check();
            const request = modelRequest(config, text, feedback);
            let xhr: XMLHttpRequest | undefined;
            try {
              const response = await Zotero.HTTP.request("POST", request.url, {
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
              check();
              return modelResponse(
                config.protocol,
                JSON.parse(response.responseText || ""),
              );
            } catch (error) {
              check();
              // Do not place headers, credentials, or full model responses in notes.
              const status = (error as { status?: number }).status;
              throw new Error(
                `模型请求失败${status ? `（HTTP ${status}）` : ""}，请检查模型配置、服务连接或返回格式。`,
              );
            } finally {
              if (xhr) this.requests.delete(xhr);
            }
          },
        },
        {
          read: async (key) => {
            const path = PathUtils.join(cache, `${key}.txt`);
            return (await IOUtils.exists(path))
              ? IOUtils.readUTF8(path)
              : undefined;
          },
          write: (key, value) =>
            IOUtils.writeUTF8(PathUtils.join(cache, `${key}.txt`), value).then(
              () => {},
            ),
        },
        hash,
        update,
        check,
        String(getPref("lightweight.mainFile") || "").trim(),
      );
      check();
      for (const entry of entries) {
        const target = PathUtils.join(project, ...entry.path.split("/"));
        await IOUtils.makeDirectory(PathUtils.parent(target)!, {
          createAncestors: true,
        });
        if (result.files.has(entry.path))
          await IOUtils.writeUTF8(target, result.files.get(entry.path)!);
        else await IOUtils.write(target, entry.data);
      }
      const main = PathUtils.join(project, ...result.main.split("/"));
      const outputDirectory = PathUtils.join(job, "pdf");
      await IOUtils.makeDirectory(outputDirectory);
      update("正在使用便携 TeX 编译译文 PDF…");
      await this.runCompiler(
        compiler,
        ["--untrusted", "--keep-logs", "--outdir", outputDirectory, main],
        PathUtils.parent(main)!,
        texCache,
        log,
        check,
      );
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
        throw new Error("便携 TeX 未生成有效的 PDF。");
      await IOUtils.writeJSON(PathUtils.join(job, "result.json"), {
        arxivId,
        main: result.main,
        requested: result.requested,
        cacheHits: result.cacheHits,
        output,
        backend: "lightweight-v1",
      });
      log(
        `翻译 ${result.requested} 段，缓存 ${result.cacheHits} 段；译文源码保存在 ${project}`,
      );
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
