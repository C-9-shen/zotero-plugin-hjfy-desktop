export interface TexCompiler {
  command: string;
  kind: "local" | "portable" | "managed";
  root?: string;
  bundledBibliography?: boolean;
}

/** Use the installed distribution as the desktop engine does, when available. */
export async function findLocalTex(
  search: (name: string) => Promise<string>,
  fallback?: () => Promise<string[]>,
): Promise<TexCompiler | undefined> {
  const tools = await Promise.allSettled([
    search("latexmk"),
    search("xelatex"),
    search("bibtex"),
    search("kpsewhich"),
  ]);
  if (tools.every((tool) => tool.status === "fulfilled" && tool.value))
    return {
      command: (tools[0] as PromiseFulfilledResult<string>).value,
      kind: "local",
    };
  // Zotero can retain the PATH from before TeX Live was installed. Check the
  // standard installation directories too, without changing the user's PATH.
  for (const directory of (await fallback?.()) || []) {
    const paths = ["latexmk", "xelatex", "bibtex", "kpsewhich"].map((name) =>
      PathUtils.join(directory, `${name}.exe`),
    );
    if (
      (await Promise.all(paths.map((path) => IOUtils.exists(path)))).every(
        Boolean,
      )
    )
      return { command: paths[0], kind: "local" };
  }
  return undefined;
}

export async function windowsTexDirectories(): Promise<string[]> {
  if (!Zotero.isWin) return [];
  const base = PathUtils.join(
    `${Services.env.get("SystemDrive") || "C:"}\\`,
    "texlive",
  );
  const years = await IOUtils.getChildren(base).catch(() => []);
  const directories = years
    .filter((path) => /^20\d\d$/.test(PathUtils.filename(path)!))
    .sort()
    .reverse()
    .map((path) => PathUtils.join(path, "bin", "windows"));
  for (const variable of ["APPDATA", "LOCALAPPDATA"]) {
    const value = Services.env.get(variable);
    if (value)
      directories.push(PathUtils.join(value, "TinyTeX", "bin", "windows"));
  }
  return directories;
}

/** Prepend the selected distribution so latexmk also finds its own children. */
export function texEnvironment(compiler: TexCompiler): Record<string, string> {
  if (compiler.kind === "portable") return {};
  const environment: Record<string, string> = {
    PATH: `${PathUtils.parent(compiler.command)}${Zotero.isWin ? ";" : ":"}${Services.env.get("PATH")}`,
  };
  if (compiler.root) {
    environment.PATH = `${PathUtils.join(compiler.root, "tlpkg", "tlperl", "bin")};${environment.PATH}`;
    environment.PERL5LIB = PathUtils.join(
      compiler.root,
      "tlpkg",
      "tlperl",
      "lib",
    );
    // Keep all mutable TeX state inside this managed distribution.
    environment.TEXMFHOME = PathUtils.join(compiler.root, "texmf-home");
    environment.TEXMFCONFIG = PathUtils.join(compiler.root, "texmf-config");
    environment.TEXMFVAR = PathUtils.join(compiler.root, "texmf-var");
    environment.TEXMFSYSVAR = environment.TEXMFVAR;
    environment.TEXMFSYSCONFIG = environment.TEXMFCONFIG;
    environment.TEXMFLOCAL = PathUtils.join(compiler.root, "texmf-local");
    environment.XE_FONTCONFIG_PATH = PathUtils.join(
      compiler.root,
      "texmf-var",
      "fonts",
      "conf",
    );
    environment.XE_FC_CACHEDIR = PathUtils.join(
      compiler.root,
      "texmf-var",
      "fonts",
      "cache",
    );
    environment.FONTCONFIG_FILE = "fonts.conf";
  }
  return environment;
}

export function missingTexFile(output: string): string | undefined {
  const match =
    /(?:LaTeX Error:\s*)?File\s+[`']([^`'\r\n]+)['`]\s+not found/i.exec(
      output,
    ) ||
    /(?:cannot find|not found[: ]+)\s*[`']?([\w.-]+\.(?:sty|cls|tfm|otf|ttf|pfb|def|fd|tex|bst|cfg|clo))/i.exec(
      output,
    );
  // Babel reports absent language definition files as an unknown option,
  // rather than a missing file. Resolve the real .ldf through the repository.
  const language =
    /Package babel Error:\s*Unknown option [`']([a-z][a-z-]*)['`]/i.exec(
      output,
    )?.[1];
  const metric =
    /Font[^\r\n]*?=([a-z0-9][a-z0-9_.+-]*)(?:\s+at\s+[\d.]+pt)?\s+not loadable:\s*Metric\s*\(TFM\)/i.exec(
      output,
    )?.[1];
  const file =
    match?.[1] ||
    (language ? `${language}.ldf` : undefined) ||
    (metric
      ? metric.endsWith(".tfm")
        ? metric
        : `${metric}.tfm`
      : undefined) ||
    /No file\s+([a-z0-9][a-z0-9_.+-]*\.fd)\./i.exec(output)?.[1];
  return file &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.+-]*\.(?:sty|cls|def|ldf|fd|tfm|vf|map|enc|otf|ttf|pfb|tex|cfg|clo|bst|lua)$/i.test(
      file,
    )
    ? file
    : undefined;
}

export function texArguments(
  compiler: TexCompiler,
  main: string,
  output: string,
  preflight = false,
): string[] {
  return compiler.kind !== "portable"
    ? [
        "-norc",
        "-g",
        ...(compiler.bundledBibliography ? ["-bibtex-"] : []),
        preflight ? "-xdv" : "-pdfxe",
        "-no-shell-escape",
        "-interaction=nonstopmode",
        "-halt-on-error",
        "-file-line-error",
        `-outdir=${output}`,
        main,
      ]
    : [
        "--untrusted",
        ...(preflight ? ["--outfmt", "xdv"] : []),
        "--keep-logs",
        "--outdir",
        output,
        main,
      ];
}

export function texFailure(output: string, local: boolean): string {
  const missing =
    /(?:LaTeX Error:\s*)?File\s+[`']([^`'\r\n]+)['`]\s+not found/i.exec(output);
  const reason = missing
    ? `缺少 TeX 依赖 ${missing[1]}。`
    : "请查看诊断目录中的 .log，确认模板、宏包及外部工具的兼容性。";
  // Keep the bounded compiler output: an old-kernel error can precede a long
  // font/memory summary, and recovery needs that original diagnostic.
  return `${local ? "本机" : "便携"} TeX 编译失败。${reason}\n${output.slice(-16000)}`;
}
