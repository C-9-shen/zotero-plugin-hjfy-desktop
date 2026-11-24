import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { Buffer } from "node:buffer";
import process from "node:process";
import path from "node:path";
import os from "node:os";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  rename,
} from "node:fs/promises";

const bundle = await build({
  stdin: {
    contents: `export * from './src/modules/latex/managedTex'; export * from './src/modules/latex/texCompiler';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const {
  compileWithTexDependencies,
  ensureManagedTex,
  findManagedTex,
  installTexDependency,
  packagesForFile,
  missingTexFile,
  findLocalTex,
  windowsTexDirectories,
  texEnvironment,
  texArguments,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const noop = () => {};
const missing = (file) => Error(`! LaTeX Error: File \`${file}' not found.`);
const managed = () => ({
  kind: "managed",
  command: "C:/fixture/TinyTeX/bin/windows/latexmk.exe",
  root: "C:/fixture/TinyTeX",
});

test("missing portable dependencies upgrade the complete kernel, then install transitive missing files and keep the chosen compiler", async () => {
  const compiler = { kind: "portable", command: "tectonic.exe" };
  let provisions = 0;
  const calls = [],
    installed = [];
  await compileWithTexDependencies(
    compiler,
    async (current) => {
      calls.push(current.kind);
      if (current.kind === "portable" || installed.length === 0)
        throw missing("wrapstuff.sty");
      if (installed.length === 1) throw missing("dependency.def");
    },
    async () => {
      provisions++;
      return managed();
    },
    async (current, file) => {
      assert.equal(current.kind, "managed");
      installed.push(file);
    },
    noop,
  );
  assert.deepEqual(calls, ["portable", "managed", "managed", "managed"]);
  assert.deepEqual(installed, ["wrapstuff.sty", "dependency.def"]);
  assert.equal(provisions, 1);
  assert.equal(compiler.kind, "managed");
  await compileWithTexDependencies(
    compiler,
    async () => {},
    async () => assert.fail("Must reuse environment"),
    async () => assert.fail("Must reuse packages"),
    noop,
  );
});

test("local missing packages use a separate environment and old expl3 errors also trigger recovery", async () => {
  for (const error of [
    missing("wrapstuff.sty"),
    Error("Package wrapstuff Error: Support package expl3 too old."),
  ]) {
    const compiler = { kind: "local", command: "C:/system/latexmk.exe" };
    let calls = 0;
    await compileWithTexDependencies(
      compiler,
      async (current) => {
        if (++calls === 1) throw error;
        assert.equal(current.root, managed().root);
      },
      async () => managed(),
      async () => assert.fail("Do not copy old-kernel package files"),
      noop,
    );
    assert.equal(calls, 2);
  }
});

test("installed kernel mismatches trigger one consistent update and preserve diagnostics before long TeX summaries", async () => {
  const compiler = managed();
  let updates = 0;
  const mismatch = Error("LaTeX Error: Mismatched LaTeX support files.");
  await compileWithTexDependencies(
    compiler,
    async () => {
      if (!updates) throw mismatch;
    },
    async () => assert.fail(),
    async () => assert.fail(),
    noop,
    async () => {
      updates++;
    },
  );
  assert.equal(updates, 1);
  updates = 0;
  await assert.rejects(
    compileWithTexDependencies(
      compiler,
      async () => {
        throw mismatch;
      },
      async () => assert.fail(),
      async () => assert.fail(),
      noop,
      async () => {
        updates++;
      },
    ),
    (e) => e === mismatch,
  );
  assert.equal(updates, 1);
});

test("source errors, unsafe filenames, repeated failures and cancellation never produce unbounded downloads", async () => {
  for (const error of [
    Error("Undefined control sequence"),
    missing("../private.sty"),
    missing("x & whoami.sty"),
  ])
    await assert.rejects(
      compileWithTexDependencies(
        { kind: "portable" },
        async () => {
          throw error;
        },
        async () => assert.fail("Unexpected download"),
        async () => assert.fail("Unexpected install"),
        noop,
      ),
      (e) => e === error,
    );
  let installs = 0;
  await assert.rejects(
    compileWithTexDependencies(
      managed(),
      async () => {
        throw missing("broken.sty");
      },
      async () => assert.fail(),
      async () => {
        installs++;
      },
      noop,
    ),
    /broken.sty/,
  );
  assert.equal(installs, 1);
  installs = 0;
  await assert.rejects(
    compileWithTexDependencies(
      managed(),
      async () => {
        throw missing(`package${installs}.sty`);
      },
      async () => assert.fail(),
      async () => {
        installs++;
      },
      noop,
    ),
    /package96.sty/,
  );
  assert.equal(installs, 96);
  await assert.rejects(
    compileWithTexDependencies(
      { kind: "portable" },
      async () => assert.fail(),
      async () => assert.fail(),
      async () => assert.fail(),
      () => {
        throw Error("cancelled");
      },
    ),
    /cancelled/,
  );
});

test("package searches accept only exact file matches under valid package names", () => {
  const text =
    "tlmgr: repository status\r\nwrapstuff:\r\n\ttexmf-dist/tex/latex/wrapstuff/wrapstuff.sty\r\nwrong:\r\n  texmf-dist/wrapstuff.sty.bak\r\nmalicious & command:\r\n  texmf-dist/wrapstuff.sty\r\n";
  assert.deepEqual(packagesForFile(text, "wrapstuff.sty"), ["wrapstuff"]);
  assert.deepEqual(
    packagesForFile(
      "fancyhdr:\n  texmf-dist/tex/latex/fancyhdr/fancyhdr.sty\npdftex:\n  texmf-dist/doc/pdftex/tests/fancyhdr.sty\n",
      "fancyhdr.sty",
    ),
    ["fancyhdr"],
  );
  assert.equal(
    missingTexFile("File `wrapstuff.sty' not found."),
    "wrapstuff.sty",
  );
  assert.equal(missingTexFile("File `../secret.sty' not found."), undefined);
  assert.equal(
    missingTexFile("Package babel Error: Unknown option 'english'."),
    "english.ldf",
  );
  assert.equal(
    missingTexFile("Package babel Error: Unknown option '../secret'."),
    undefined,
  );
  assert.equal(
    missingTexFile(
      "Font OT1/ppl/m/n/7.52812=pplr7t at 7.52812pt not loadable: Metric (TFM) file or installed font not found.",
    ),
    "pplr7t.tfm",
  );
  assert.equal(
    missingTexFile("LaTeX Font Info: No file OMLzchmi.fd. on input line 270."),
    "OMLzchmi.fd",
  );
  assert.equal(missingTexFile("No file main.aux."), undefined);
  assert.deepEqual(
    packagesForFile(
      "xcharter:\n  texmf-dist/tex/latex/xcharter/omlzchmi.fd\n",
      "OMLzchmi.fd",
    ),
    ["xcharter"],
  );
  assert.equal(
    missingTexFile(
      "Font X=../secret at 10pt not loadable: Metric (TFM) file not found.",
    ),
    undefined,
  );
});

test("Windows discovery finds full standard installations outside Zotero's inherited PATH and prepends one distribution", async () => {
  globalThis.PathUtils = {
    join: path.win32.join,
    parent: path.win32.dirname,
    filename: path.win32.basename,
  };
  globalThis.Zotero = { isWin: true };
  globalThis.Services = {
    env: {
      get: (key) =>
        ({
          SystemDrive: "C:",
          PATH: "C:\\old\\bin",
          APPDATA: "C:\\Users\\fixture\\AppData\\Roaming",
        })[key] || "",
    },
  };
  globalThis.IOUtils = {
    getChildren: async () => [
      "C:\\texlive\\2025",
      "C:\\texlive\\2026",
      "C:\\texlive\\unrelated",
    ],
    exists: async (name) => name.startsWith("C:\\texlive\\2025\\"),
  };
  const compiler = await findLocalTex(async () => {
    throw Error("stale PATH");
  }, windowsTexDirectories);
  assert.equal(
    compiler.command,
    "C:\\texlive\\2025\\bin\\windows\\latexmk.exe",
  );
  assert.equal(
    texEnvironment(compiler).PATH,
    "C:\\texlive\\2025\\bin\\windows;C:\\old\\bin",
  );
  const env = texEnvironment(managed());
  assert.ok(env.PATH.startsWith("C:\\fixture\\TinyTeX\\tlpkg\\tlperl\\bin;"));
  assert.ok(env.TEXMFVAR.endsWith("texmf-var"));
  assert.equal(env.TEXMFSYSVAR, env.TEXMFVAR);
  assert.equal(env.TEXMFSYSCONFIG, env.TEXMFCONFIG);
  assert.equal(env.FONTCONFIG_FILE, "fonts.conf");
  assert.ok(env.XE_FONTCONFIG_PATH.endsWith("texmf-var\\fonts\\conf"));
  assert.ok(env.XE_FC_CACHEDIR.endsWith("texmf-var\\fonts\\cache"));
  assert.deepEqual(texEnvironment({ kind: "portable" }), {});
  for (const option of ["-norc", "-g", "-no-shell-escape", "-xdv"])
    assert.ok(
      texArguments(managed(), "main.tex", "out", true).includes(option),
    );
});

async function setupRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hjfy-managed-test-"));
  const exists = (name) =>
    access(name).then(
      () => true,
      () => false,
    );
  globalThis.PathUtils = {
    join: path.join,
    parent: path.dirname,
    profileDir: root,
  };
  globalThis.Services = {
    appinfo: { XPCOMABI: "x86_64-msvc" },
    env: {
      get: (key) => (key === "SystemRoot" ? "C:/Windows" : "fixture-path"),
    },
  };
  globalThis.Zotero = {
    isWin: true,
    File: {
      download: async (_url, dest) =>
        writeFile(dest, "Fixture; never executed"),
    },
  };
  globalThis.IOUtils = {
    exists,
    makeDirectory: (p) => mkdir(p, { recursive: true }),
    readJSON: async (p) => JSON.parse(await readFile(p, "utf8")),
    writeJSON: (p, d) => writeFile(p, JSON.stringify(d)),
    remove: (p) => rm(p, { force: true }),
    move: rename,
    computeHexDigest: async () =>
      "375e8adec0177cd9ec6a1f8c76efe0c22b1a0c260e76a00386bcea52d88e5354",
  };
  return root;
}

test("managed environment verifies the archive, shares initialization, updates tlmgr and reuses the completed cache", async () => {
  const root = await setupRuntime();
  let downloads = 0,
    extractions = 0,
    installs = 0,
    fontSetups = 0,
    updated = false;
  const calls = [];
  globalThis.Zotero.File.download = async (_url, dest) => {
    downloads++;
    await writeFile(dest, "Fixture only");
  };
  const run = async (command, args, workdir, env) => {
    calls.push({ command, args, env });
    if (command.endsWith("download.exe")) {
      extractions++;
      assert.deepEqual(args, ["-y", `-o${workdir}`]);
      for (const file of [
        "bin/windows/latexmk.exe",
        "bin/windows/xelatex.exe",
        "tlpkg/tlperl/bin/perl.exe",
      ]) {
        const dest = path.join(workdir, "TinyTeX", file);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, "Fixture only");
      }
    } else if (args.includes("postaction")) {
      assert.deepEqual(args.slice(-4), [
        "postaction",
        "install",
        "script",
        "xetex",
      ]);
      fontSetups++;
    } else if (args.includes("install")) {
      installs++;
      if (!updated) throw Error("tlmgr itself needs to be updated.");
      assert.deepEqual(args.slice(-3), ["install", "ctex", "fandol"]);
    } else if (args.includes("update")) {
      assert.ok(args.includes("--self"));
      await mkdir(path.join(workdir, "temp"));
      await writeFile(path.join(workdir, "temp/updater-w32"), "Fixture only");
    } else if (command.endsWith("cmd.exe")) {
      assert.deepEqual(args.slice(-2), [".\\updater-w32.bat", ":doit"]);
      assert.ok(workdir.endsWith("temp"));
      assert.ok(env.PATH.includes("tlperl"));
      updated = true;
    } else assert.fail("Unexpected command");
    return "";
  };
  try {
    const [a, b] = await Promise.all([
      ensureManagedTex(run, noop, noop),
      ensureManagedTex(run, noop, noop),
    ]);
    assert.deepEqual(a, b);
    assert.equal(a.kind, "managed");
    assert.equal(downloads, 1);
    assert.equal(extractions, 1);
    assert.equal(installs, 2);
    assert.equal(fontSetups, 1);
    const count = calls.length;
    assert.deepEqual(await ensureManagedTex(run, noop, noop), a);
    assert.equal(calls.length, count);
    assert.equal(downloads, 1);
    const receipt = path.join(path.dirname(a.root), "ready.json");
    assert.ok(await globalThis.IOUtils.exists(receipt));
    assert.equal(
      (await globalThis.IOUtils.readJSON(receipt)).fontsConfigured,
      true,
    );
    assert.ok(
      !(await globalThis.IOUtils.exists(
        path.join(path.dirname(a.root), "download.exe"),
      )),
    );
    await globalThis.IOUtils.writeJSON(receipt, {
      archive:
        "375e8adec0177cd9ec6a1f8c76efe0c22b1a0c260e76a00386bcea52d88e5354",
    });
    await rm(path.join(path.dirname(a.root), "extracted.json"));
    assert.equal(await findManagedTex(), undefined);
    await ensureManagedTex(run, noop, noop);
    assert.equal(fontSetups, 2);
    assert.equal(downloads, 1);
    assert.equal(extractions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive mismatch and cancellation stop before execution, leave no ready receipt, and allow a later retry", async () => {
  const root = await setupRuntime();
  try {
    globalThis.IOUtils.computeHexDigest = async () => "mismatch";
    await assert.rejects(
      ensureManagedTex(
        async () => assert.fail("Must not execute damaged archive"),
        noop,
        noop,
      ),
      /校验失败/,
    );
    const directory = path.join(
      root,
      "hjfy-lightweight/runtime/tinytex-2026.11",
    );
    assert.ok(
      !(await globalThis.IOUtils.exists(path.join(directory, "ready.json"))),
    );
    assert.ok(
      !(await globalThis.IOUtils.exists(path.join(directory, "download.exe"))),
    );
    let cancelled = false;
    globalThis.Zotero.File.download = async () => {
      cancelled = true;
    };
    await assert.rejects(
      ensureManagedTex(
        async () => assert.fail(),
        noop,
        () => {
          if (cancelled) throw Error("cancelled");
        },
      ),
      /cancelled/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted package downloads resume from the verified extracted environment without downloading it again", async () => {
  const root = await setupRuntime();
  let extractions = 0;
  const run = async (command, args, workdir) => {
    if (command.endsWith("download.exe")) {
      extractions++;
      for (const file of [
        "bin/windows/latexmk.exe",
        "bin/windows/xelatex.exe",
        "tlpkg/tlperl/bin/perl.exe",
      ]) {
        const dest = path.join(workdir, "TinyTeX", file);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, "Fixture only");
      }
      return "";
    }
    assert.ok(args.includes("install"));
    throw Error("Network interrupted");
  };
  try {
    await assert.rejects(
      ensureManagedTex(run, noop, noop),
      /Network interrupted/,
    );
    assert.equal(await findManagedTex(), undefined);
    globalThis.Zotero.File.download = async () =>
      assert.fail("Must reuse extracted environment");
    const compiler = await ensureManagedTex(
      async (command, args) => {
        assert.ok(command.endsWith("perl.exe"));
        assert.ok(args.includes("install"));
        return "";
      },
      noop,
      noop,
    );
    assert.equal(extractions, 1);
    assert.deepEqual(await findManagedTex(), compiler);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dependency installation escapes file patterns, resolves the owning package, stops for absent project files and deduplicates concurrent installs", async () => {
  const root = await setupRuntime();
  const compiler = managed();
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("search")) {
      assert.equal(args.at(-1), "(?i)/wrapstuff\\.sty$");
      return "wrapstuff:\n  texmf-dist/tex/latex/wrapstuff/wrapstuff.sty\n";
    }
    assert.deepEqual(args.slice(-3), ["install", "--reinstall", "wrapstuff"]);
    return "installed";
  };
  try {
    await Promise.all([
      installTexDependency(compiler, "wrapstuff.sty", run, noop, noop),
      installTexDependency(compiler, "wrapstuff.sty", run, noop, noop),
    ]);
    assert.equal(calls.filter((c) => c.args.includes("install")).length, 1);
    await assert.rejects(
      installTexDependency(
        compiler,
        "paper-private.sty",
        async () => "",
        noop,
        noop,
      ),
      /仓库未找到/,
    );
    await assert.rejects(
      installTexDependency(
        compiler,
        "../evil.sty",
        async () => assert.fail(),
        noop,
        noop,
      ),
      /无效/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
