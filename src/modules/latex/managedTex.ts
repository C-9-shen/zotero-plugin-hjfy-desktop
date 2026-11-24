import {
  missingTexFile,
  texEnvironment,
  type TexCompiler,
} from "./texCompiler";
import { TaskQueue } from "../../utils/taskQueue";

// Official monthly Windows distribution, including Perl and tlmgr. The complete
// kernel is kept together: copying a new .sty into Tectonic's 2021 bundle fails
// when that package requires a newer expl3/LaTeX.
const VERSION = "2026.11";
const SHA256 =
  "375e8adec0177cd9ec6a1f8c76efe0c22b1a0c260e76a00386bcea52d88e5354";
export const MANAGED_TEX_URL = `https://github.com/rstudio/tinytex-releases/releases/download/v${VERSION}/TinyTeX-1-windows-v${VERSION}.exe`;
const REPOSITORY =
  "https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet";

export type TexToolRunner = (
  command: string,
  args: string[],
  workdir: string,
  environment: Record<string, string>,
) => Promise<string>;

let preparing: Promise<TexCompiler> | undefined;
const maintenance = new TaskQueue(1);

function managedPaths() {
  const directory = PathUtils.join(
    PathUtils.profileDir,
    "hjfy-lightweight",
    "runtime",
    `tinytex-${VERSION}`,
  );
  const root = PathUtils.join(directory, "TinyTeX");
  const compiler: TexCompiler = {
    command: PathUtils.join(root, "bin", "windows", "latexmk.exe"),
    kind: "managed",
    root,
  };
  return { directory, root, compiler };
}

async function matchesReceipt(path: string, requireFonts = false) {
  if (!(await IOUtils.exists(path))) return false;
  const receipt = (await IOUtils.readJSON(path).catch(() => undefined)) as
    | { archive?: string; fontsConfigured?: boolean }
    | undefined;
  return (
    receipt?.archive === SHA256 &&
    (!requireFonts || receipt.fontsConfigured === true)
  );
}

async function hasRequiredPrograms(compiler: TexCompiler) {
  return (
    await Promise.all(
      [
        compiler.command,
        PathUtils.join(compiler.root!, "bin", "windows", "xelatex.exe"),
        PathUtils.join(compiler.root!, "tlpkg", "tlperl", "bin", "perl.exe"),
      ].map((file) => IOUtils.exists(file)),
    )
  ).every(Boolean);
}

export async function findManagedTex(): Promise<TexCompiler | undefined> {
  if (!Zotero.isWin) return undefined;
  const { directory, compiler } = managedPaths();
  return (await matchesReceipt(
    PathUtils.join(directory, "ready.json"),
    true,
  )) && (await hasRequiredPrograms(compiler))
    ? compiler
    : undefined;
}

export async function ensureManagedTex(
  run: TexToolRunner,
  update: (message: string) => void,
  check: () => void,
): Promise<TexCompiler> {
  check();
  if (!preparing) {
    preparing = prepare(run, update, check);
  } else update("正在等待自动 TeX 环境准备完成…");
  const current = preparing;
  try {
    const compiler = await current;
    check();
    return compiler;
  } finally {
    if (preparing === current) preparing = undefined;
  }
}

async function prepare(
  run: TexToolRunner,
  update: (message: string) => void,
  check: () => void,
): Promise<TexCompiler> {
  if (!Zotero.isWin || !Services.appinfo.XPCOMABI.startsWith("x86_64"))
    throw new Error("自动补齐 TeX 环境目前仅支持 Windows x64。");
  const { directory, compiler } = managedPaths();
  const receipt = PathUtils.join(directory, "ready.json");
  if (await findManagedTex()) return compiler;
  await IOUtils.makeDirectory(directory, { createAncestors: true });
  // A shared preparation promise prevents two tasks from extracting/installing
  // into the same environment. The receipt is written only after installation.
  const archive = PathUtils.join(directory, "download.exe");
  try {
    const extracted = PathUtils.join(directory, "extracted.json");
    if (
      (!(await matchesReceipt(extracted)) &&
        !(await matchesReceipt(receipt))) ||
      !(await hasRequiredPrograms(compiler))
    ) {
      update(`自动下载兼容的 TeX 环境 TinyTeX ${VERSION}（约 70 MiB）…`);
      await Zotero.File.download(MANAGED_TEX_URL, archive);
      check();
      if ((await IOUtils.computeHexDigest(archive, "sha256")) !== SHA256)
        throw new Error("自动 TeX 环境下载校验失败，未运行该文件。");
      update("正在解压独立 TeX 环境…");
      await run(archive, ["-y", `-o${directory}`], directory, {});
      check();
      if (!(await hasRequiredPrograms(compiler)))
        throw new Error("自动 TeX 环境缺少必要程序，未标记为可用。");
      await IOUtils.writeJSON(extracted, { archive: SHA256 });
    }
    update("正在下载中文排版宏包及字体…");
    await tlmgr(compiler, ["install", "ctex", "fandol"], run);
    check();
    // The archive's fonts.conf contains the release builder's absolute paths.
    // TeX Live's own post-install action relocates them and rebuilds the cache.
    update("正在配置独立环境的字体目录…");
    await tlmgr(compiler, ["postaction", "install", "script", "xetex"], run);
    check();
    await IOUtils.writeJSON(receipt, {
      archive: SHA256,
      version: VERSION,
      fontsConfigured: true,
    });
    return compiler;
  } finally {
    await IOUtils.remove(archive, { ignoreAbsent: true });
  }
}

async function tlmgr(
  compiler: TexCompiler,
  args: string[],
  run: TexToolRunner,
) {
  return maintenance.run(`${compiler.root}:${JSON.stringify(args)}`, () =>
    maintain(compiler, args, run),
  );
}

async function maintain(
  compiler: TexCompiler,
  args: string[],
  run: TexToolRunner,
) {
  try {
    return await rawTlmgr(compiler, args, run);
  } catch (error) {
    if (!/tlmgr itself needs to be updated/i.test(String(error))) throw error;
    // Monthly TinyTeX archives can lag the live repository's manager. Follow
    // TeX Live's own Windows updater protocol, including its rollback support.
    await rawTlmgr(compiler, ["update", "--self"], run);
    const pending = PathUtils.join(compiler.root!, "temp", "updater-w32");
    if (await IOUtils.exists(pending)) {
      const updater = `${pending}.bat`;
      await IOUtils.move(pending, updater, { noOverwrite: false });
      await run(
        PathUtils.join(Services.env.get("SystemRoot"), "System32", "cmd.exe"),
        ["/d", "/v:off", "/c", ".\\updater-w32.bat", ":doit"],
        PathUtils.parent(updater)!,
        texEnvironment(compiler),
      );
    }
    return rawTlmgr(compiler, args, run);
  }
}

function rawTlmgr(compiler: TexCompiler, args: string[], run: TexToolRunner) {
  const root = compiler.root!;
  // Invoke Perl directly: no cmd.exe interpolation, batch wrapper, or global
  // PATH/registry modification. tlmgr installs dependencies automatically.
  return run(
    PathUtils.join(root, "tlpkg", "tlperl", "bin", "perl.exe"),
    [
      PathUtils.join(root, "texmf-dist", "scripts", "texlive", "tlmgr.pl"),
      "--repository",
      REPOSITORY,
      ...args,
    ],
    root,
    texEnvironment(compiler),
  );
}

export function packagesForFile(output: string, file: string): string[] {
  const packages = new Set<string>();
  let current: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const header = /^([a-z0-9][a-z0-9+_.-]*):\s*$/.exec(line);
    if (header) current = header[1];
    else if (line && !/^\s/.test(line)) current = undefined;
    const path = line.trim();
    // Documentation can include copies of another package's files (e.g.
    // pdftex's tests contain fancyhdr.sty). Only install usable runtime files.
    if (
      current &&
      path.toLowerCase().endsWith(`/${file.toLowerCase()}`) &&
      !/(?:^|\/)(?:doc|source)\//.test(path)
    )
      packages.add(current);
  }
  return [...packages];
}

export async function installTexDependency(
  compiler: TexCompiler,
  file: string,
  run: TexToolRunner,
  update: (message: string) => void,
  check: () => void,
) {
  check();
  if (
    compiler.kind !== "managed" ||
    missingTexFile(`File '${file}' not found`) !== file
  )
    throw new Error("无效的自动 TeX 依赖请求。");
  update(`正在查找缺失依赖 ${file}…`);
  const pattern = `(?i)/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const found = packagesForFile(
    await tlmgr(compiler, ["search", "--global", "--file", pattern], run),
    file,
  );
  check();
  if (!found.length)
    throw new Error(
      `TeX Live 仓库未找到 ${file}；可能是论文归档缺少自带文件。`,
    );
  update(`自动下载宏包 ${found.join("、")} 及其依赖…`);
  await tlmgr(compiler, ["install", "--reinstall", ...found], run);
  check();
}

export async function updateManagedTex(
  compiler: TexCompiler,
  run: TexToolRunner,
  update: (message: string) => void,
  check: () => void,
) {
  check();
  if (compiler.kind !== "managed") throw new Error("只能更新独立 TeX 环境。");
  update("正在同步独立 TeX 环境的内核与已安装宏包版本…");
  await tlmgr(compiler, ["update", "--all"], run);
  check();
}

/** Retry only actionable dependency failures; never mask damaged TeX source. */
export async function compileWithTexDependencies(
  compiler: TexCompiler,
  compile: (compiler: TexCompiler) => Promise<unknown>,
  provision: () => Promise<TexCompiler>,
  install: (compiler: TexCompiler, file: string) => Promise<void>,
  check: () => void,
  upgrade?: (compiler: TexCompiler) => Promise<void>,
) {
  const attempted = new Set<string>();
  let upgraded = false;
  for (;;) {
    check();
    try {
      await compile(compiler);
      return;
    } catch (error) {
      check();
      const message = error instanceof Error ? error.message : String(error);
      const file = missingTexFile(message);
      const oldKernel =
        /(?:LaTeX|expl3).*(?:too old|too-old|older than|or later is required)|Mismatched LaTeX support files|Support package.*(?:too old|too-old)/i.test(
          message,
        );
      if (compiler.kind !== "managed") {
        if (!file && !oldKernel) throw error;
        const next = await provision();
        check();
        Object.assign(compiler, next);
        // Recompile with the consistent kernel first. Many dependencies are
        // already included there, so do not install based on the old log.
        continue;
      }
      if (oldKernel && upgrade && !upgraded) {
        upgraded = true;
        await upgrade(compiler);
        continue;
      }
      if (!file || attempted.has(file) || attempted.size >= 96) throw error;
      attempted.add(file);
      await install(compiler, file);
    }
  }
}
