import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate, setTimeout, clearTimeout } from "node:timers";
import { build } from "esbuild";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { gzipSync } from "fflate";

const bundle = await build({
  stdin: {
    contents: `export { ArxivTranslationFactory } from './src/modules/arxivTranslation';
      export { DesktopTranslation } from './src/modules/desktopTranslation';
      export { LightweightTranslation } from './src/modules/lightweightTranslation';
      export { ensurePortableTex } from './src/modules/latex/portableTex';
      export { translationTaskSnapshot } from './src/modules/translationTasks';
      export { openTranslationReaders } from './src/modules/translationReader';
      export { readSourceArchive } from './src/utils/sourceArchive';
      export { getPageProgress, getPageScrollTop } from './src/utils/pageProgress';
      export { parseArxivId, parseArxivExtra } from './src/utils/arxivId';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const {
  ArxivTranslationFactory: Factory,
  DesktopTranslation,
  LightweightTranslation,
  ensurePortableTex,
  translationTaskSnapshot,
  openTranslationReaders,
  readSourceArchive,
  getPageProgress,
  getPageScrollTop,
  parseArxivId,
  parseArxivExtra,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

test("page-relative scrolling preserves progress across zoom and unequal page heights", () => {
  const source = [
    { top: 10, height: 1000 },
    { top: 1020, height: 1500 },
    { top: 2530, height: 800 },
  ];
  const target = source.map((page) => ({
    top: page.top * 2,
    height: page.height * 2,
  }));
  for (const progress of [0, 0.5, 0.99, 1, 1.3, 2.4]) {
    const sourceTop = getPageScrollTop(progress, source);
    assert.ok(Math.abs(getPageProgress(sourceTop, source) - progress) < 1e-9);
    assert.equal(getPageScrollTop(progress, target), sourceTop * 2);
  }
  // Moving half a page crosses the boundary between two differently sized pages.
  const start = getPageScrollTop(0.8, source);
  const delta =
    getPageProgress(getPageScrollTop(1.3, source), source) -
    getPageProgress(start, source);
  assert.ok(Math.abs(delta - 0.5) < 1e-9);
  assert.equal(
    getPageScrollTop(1.1 + delta, target),
    getPageScrollTop(1.6, target),
  );
  const differentLayout = [
    { top: 20, height: 1700 },
    { top: 1730, height: 900 },
    { top: 2640, height: 1300 },
  ];
  assert.equal(getPageScrollTop(1.1 + delta, differentLayout), 2276);
  assert.equal(getPageProgress(2276, differentLayout), 1.6);
});

test("arXiv identifiers retain explicit versions and reject unrelated URLs", () => {
  for (const value of [
    "arxiv:2610.34593v1",
    "2610.34593v1",
    "10.48550/arXiv.2610.34593v1",
    "https://arxiv.org/abs/2610.34593v1",
    "https://arxiv.org/pdf/2610.34593v1.pdf?download=1",
  ]) {
    assert.equal(parseArxivId(value), "2610.34593v1");
  }
  assert.equal(
    parseArxivId("https://arxiv.org.evil.test/abs/2610.34593v1"),
    null,
  );
  assert.equal(parseArxivId("2610.34593v0"), null);
  assert.equal(parseArxivId("2610.34593v1/../../file"), null);
  assert.equal(parseArxivId("hep-th/9901001v2"), "hep-th/9901001v2");
  assert.equal(
    parseArxivExtra("Other: value\narXiv ID: 2610.34593v1"),
    "2610.34593v1",
  );
});

test("item URL version takes precedence over an unversioned DOI", () => {
  const values = {
    DOI: "10.48550/arXiv.2610.34593",
    url: "https://arxiv.org/abs/2610.34593v1",
  };
  assert.equal(
    Factory.extractArxivIdFromItem({ getField: (name) => values[name] || "" }),
    "2610.34593v1",
  );
});

test("await attachment existence and distinguish revisions", async () => {
  globalThis.Zotero = {
    Items: {
      get: () => ({
        attachmentFilename: "paper_hjfy_arxiv_2610.34593v1.pdf",
        fileExists: async () => false,
      }),
    },
  };
  const item = { getAttachments: () => [1] };
  assert.equal(
    await Factory.findExistingTranslationAttachment(
      item,
      "paper_hjfy_arxiv_2610.34593v1.pdf",
    ),
    null,
  );
  globalThis.Zotero.Items.get = () => ({
    attachmentFilename: "paper_hjfy_arxiv_2610.34593v1.pdf",
    fileExists: async () => true,
  });
  assert.ok(
    await Factory.findExistingTranslationAttachment(
      item,
      "paper_hjfy_arxiv_2610.34593v1.pdf",
    ),
  );
  assert.equal(
    await Factory.findExistingTranslationAttachment(
      item,
      "paper_hjfy_arxiv_2610.34593v2.pdf",
    ),
    null,
  );
});

test("desktop adapter handles split UTF-8 JSONL, validates outputs and rejects failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hjfy-adapter-test-"));
  const pdf = path.join(directory, "translated.pdf");
  // A header fixture tests adapter validation; no document is generated here.
  await writeFile(pdf, "%PDF-fixture");
  globalThis.PathUtils = {
    ...path,
    profileDir: directory,
    isAbsolute: path.isAbsolute,
    parent: path.dirname,
  };
  globalThis.IOUtils = {
    makeDirectory: (p) => mkdir(p, { recursive: true }),
    writeUTF8: writeFile,
    writeJSON: (p, data) => writeFile(p, JSON.stringify(data)),
    exists: async (p) => {
      try {
        await readFile(p);
        return true;
      } catch {
        return false;
      }
    },
    read: async (p) => new Uint8Array((await readFile(p)).subarray(0, 5)),
  };
  globalThis.Zotero = {
    isWin: true,
    Utilities: { randomString: () => "probe" },
    Prefs: { get: () => "" },
  };
  globalThis.Services = { env: { get: () => directory } };
  let events;
  let exitCode = 0;
  let submitted;
  let terminated = 0;
  const launches = [];
  const originalPrepare = DesktopTranslation.prepareTask;
  DesktopTranslation.prepareTask = async (arxivId) => {
    submitted = arxivId;
    return {
      command: path.join(directory, "hjfy-office.exe"),
      arguments: [
        "--latex-project",
        directory,
        "--api-key-env",
        "HJFY_PLUGIN_API_KEY",
      ],
      environment: { HJFY_PLUGIN_API_KEY: "secret-fixture" },
      environmentAppend: true,
      stderr: "pipe",
    };
  };
  globalThis.ChromeUtils = {
    importESModule: () => ({
      Subprocess: {
        pathSearch: async () => {
          throw new Error("Executable PATH search is forbidden");
        },
        call: async (options) => {
          launches.push(options);
          if (options.command.endsWith("taskkill.exe")) {
            terminated++;
            return { wait: async () => ({ exitCode: 0 }) };
          }
          assert.ok(options.command.endsWith("hjfy-office.exe"));
          assert.ok(path.isAbsolute(options.command));
          assert.equal(
            options.environment.HJFY_PLUGIN_API_KEY,
            "secret-fixture",
          );
          assert.ok(!options.arguments.join(" ").includes("secret-fixture"));
          const chunks = [
            events.slice(0, 7),
            events.slice(7, 29),
            events.slice(29),
          ];
          return {
            pid: 123,
            stdin: {
              close: async () => {},
            },
            stdout: { readString: async () => chunks.shift() || "" },
            stderr: { readString: async () => "" },
            wait: async () => ({ exitCode }),
          };
        },
      },
    }),
  };
  try {
    events = `${JSON.stringify({ type: "progress", message: { text: "正在翻译" } })}\n${JSON.stringify({ type: "run_finished", outcome: "succeeded", output_pdf: pdf })}\n`;
    const messages = [];
    assert.equal(
      await DesktopTranslation.translate("2610.34593v1", (s) =>
        messages.push(s),
      ),
      pdf,
    );
    assert.equal(submitted, "2610.34593v1");
    assert.ok(messages.includes("正在翻译"));
    assert.equal(launches[0].stderr, "pipe");
    assert.equal(terminated, 0);
    assert.equal(launches[0].environment.HJFY_PLUGIN_API_KEY, "");
    events = `${JSON.stringify({ type: "run_finished", outcome: "succeeded", output_pdf: pdf, result: { translation: { fallback_originals: 1 } } })}\n`;
    await assert.rejects(
      DesktopTranslation.translate("2610.34593v1", () => {}),
      /不完整译文/,
    );
    events = `${JSON.stringify({ type: "run_finished", outcome: "failed", output_pdf: pdf })}\n`;
    exitCode = 1;
    await assert.rejects(
      DesktopTranslation.translate("2610.34593v1", () => {}),
      /翻译失败/,
    );
    exitCode = 0;
    events = `${JSON.stringify({ type: "run_finished", outcome: "succeeded" })}\n`;
    await assert.rejects(
      DesktopTranslation.translate("2610.34593v1", () => {}),
      /未生成/,
    );
    events = `${JSON.stringify({ type: "run_finished", outcome: "succeeded", output_pdf: pdf })}\n`;
    await writeFile(pdf, "<html>error</html>");
    await assert.rejects(
      DesktopTranslation.translate("2610.34593v1", () => {}),
      /不是有效的 PDF/,
    );
  } finally {
    DesktopTranslation.prepareTask = originalPrepare;
    await rm(directory, { recursive: true, force: true });
  }
});

function tarEntry(name, content = "", type = "0") {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header[156] = type.charCodeAt(0);
  header.write("ustar\0", 257);
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return Buffer.concat([
    header,
    data,
    Buffer.alloc((512 - (data.length % 512)) % 512),
  ]);
}

test("JavaScript source extraction supports gzip/tar, PAX and single TeX while rejecting unsafe entries", () => {
  const tex = "\\documentclass{article}\\begin{document}Test\\end{document}";
  const tar = Buffer.concat([
    tarEntry("./project/main.tex", tex),
    tarEntry("project/fig.txt", "figure"),
    Buffer.alloc(1024),
  ]);
  const entries = readSourceArchive(gzipSync(tar));
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["project/main.tex", "project/fig.txt"],
  );
  assert.equal(Buffer.from(entries[0].data).toString(), tex);
  assert.equal(
    readSourceArchive(gzipSync(Buffer.from(tex)))[0].path,
    "main.tex",
  );
  const record = "23 path=other/main.tex\n";
  assert.equal(Buffer.byteLength(record), 23);
  const pax = Buffer.concat([
    tarEntry("pax", record, "x"),
    tarEntry("main.tex", tex),
  ]);
  assert.equal(readSourceArchive(pax)[0].path, "other/main.tex");
  for (const name of [
    "../main.tex",
    "/main.tex",
    "C:/main.tex",
    "dir\\main.tex",
    "aux.tex",
    "folder./main.tex",
  ]) {
    assert.throws(() => readSourceArchive(tarEntry(name, tex)), /不安全/);
  }
  assert.throws(
    () =>
      readSourceArchive(
        Buffer.concat([tarEntry("main.tex", tex), tarEntry("link", "", "2")]),
      ),
    /链接/,
  );
  assert.throws(
    () =>
      readSourceArchive(
        Buffer.concat([tarEntry("main.tex", tex), tarEntry("MAIN.tex", tex)]),
      ),
    /重复/,
  );
  assert.throws(() => readSourceArchive(tar.subarray(0, 520)), /不完整/);
  assert.throws(
    () => readSourceArchive(Buffer.from("<html>rate limited</html>")),
    /LaTeX/,
  );
});

test("successful attachment import uses the translated file and cleans its staging copy", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hjfy-attachment-test-"),
  );
  const pdf = path.join(directory, "translated.pdf");
  await writeFile(pdf, "translated fixture");
  let imported;
  let saved = false;
  globalThis.IOUtils = { copy: copyFile, remove: rm };
  globalThis.Zotero = {
    Attachments: {
      importFromFile: async ({ file, parentItemID }) => {
        imported = {
          content: await readFile(file, "utf8"),
          file,
          parentItemID,
        };
        return {
          setField: () => {},
          saveTx: async () => {
            saved = true;
          },
        };
      },
    },
  };
  try {
    await Factory.savePdfAsAttachment(
      { id: 17, getDisplayTitle: () => "Test paper" },
      pdf,
      "2610.34593v1",
    );
    assert.equal(imported.content, "translated fixture");
    assert.equal(imported.parentItemID, 17);
    assert.ok(imported.file.endsWith("2610.34593v1.pdf"));
    assert.ok(saved);
    await assert.rejects(readFile(imported.file));
    assert.equal(await readFile(pdf, "utf8"), "translated fixture");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch translation continues after failures without opening progress notifications", async () => {
  const originalTranslate = Factory.translateSingleItem;
  const visited = [];
  const errors = [];
  globalThis.addon = { data: { alive: true } };
  globalThis.ztoolkit = {
    ProgressWindow: class {
      constructor() {
        assert.fail("Translation must not open a progress notification");
      }
    },
    log: (...args) => errors.push(args),
  };
  Factory.translateSingleItem = async (item) => {
    visited.push(item.id);
    if (item.id === 1) throw new Error("Test failure");
  };
  try {
    await Factory.translateSelectedItems([{ id: 1 }, { id: 2 }]);
    await Factory.translateSelectedItems([{ id: 3 }]);
    assert.deepEqual(visited, [1, 2, 3]);
    assert.equal(errors.length, 1);
  } finally {
    Factory.translateSingleItem = originalTranslate;
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("translation queue accepts new batches, limits parallel jobs, deduplicates items and survives failures", async () => {
  const original = Factory.translateItem;
  const gates = new Map([1, 2, 3, 4].map((id) => [id, deferred()]));
  const started = [];
  const errors = [];
  let active = 0,
    maximum = 0;
  const items = [1, 2, 3, 4].map((id) => ({
    id,
    libraryID: 908,
    isRegularItem: () => true,
    getField: () => "",
    getDisplayTitle: () => `Paper ${id}`,
  }));
  globalThis.addon = { data: { alive: true } };
  globalThis.ztoolkit = { log: (...args) => errors.push(args) };
  Factory.translateItem = async (item, report) => {
    started.push(item.id);
    active++;
    maximum = Math.max(maximum, active);
    report(`progress ${item.id}`);
    await gates.get(item.id).promise;
    active--;
    if (item.id === 2) throw new Error("queue fixture failure");
    return item.id;
  };
  const first = Factory.translateSelectedItems(items.slice(0, 3));
  const second = Factory.translateSelectedItems([items[1], items[3]]);
  const duplicate = Factory.translateSingleItem(items[0]);
  try {
    await tick();
    assert.deepEqual(started, [1, 2]);
    const states = translationTaskSnapshot().filter((t) =>
      t.key.startsWith("908:"),
    );
    assert.deepEqual(
      states.map((t) => t.status),
      ["运行中", "运行中", "排队中", "排队中"],
    );
    gates.get(1).resolve();
    await tick();
    assert.deepEqual(started, [1, 2, 3]);
    gates.get(2).resolve();
    await tick();
    assert.deepEqual(started, [1, 2, 3, 4]);
    gates.get(3).resolve();
    gates.get(4).resolve();
    await Promise.all([first, second, duplicate]);
    assert.equal(maximum, 2);
    assert.ok(errors.length >= 1);
    assert.equal(
      translationTaskSnapshot().find((t) => t.key === "908:2").status,
      "失败",
    );
    // Completed tasks can be submitted again (e.g. to open an existing PDF).
    await Factory.translateSingleItem(items[0]);
    assert.equal(started.filter((id) => id === 1).length, 2);
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await Promise.allSettled([first, second, duplicate]);
    Factory.translateItem = original;
  }
});

test("successful imports remove their progress note and diagnostics while failures retain their note", async () => {
  const originalTranslate = LightweightTranslation.translate;
  const originalCleanup = LightweightTranslation.cleanup;
  const originalSave = Factory.savePdfAsAttachment;
  const events = [],
    notes = [];
  let failing = false;
  globalThis.addon = { data: { alive: true } };
  globalThis.ChromeUtils = {
    importESModule: () => ({ setTimeout, clearTimeout }),
  };
  globalThis.Zotero = {
    Prefs: { get: () => "lightweight" },
    logError: (error) => {
      throw error;
    },
    Item: class {
      constructor() {
        notes.push(this);
      }
      setNote(html) {
        this.html = html;
      }
      async saveTx() {
        this.id = 99;
        events.push("save-note");
      }
      async eraseTx() {
        events.push("erase-note");
      }
    },
  };
  const item = {
    id: 500,
    libraryID: 909,
    isRegularItem: () => true,
    getDisplayTitle: () => "Lifecycle paper",
    getAttachments: () => [],
    getField: (name) =>
      name === "url" ? "https://arxiv.org/abs/2610.34593v1" : "",
  };
  LightweightTranslation.translate = async (_id, report) => {
    events.push("translate");
    report("正文翻译 1/2");
    if (failing) throw new Error("failure <diagnostic>");
    return "output.pdf";
  };
  LightweightTranslation.cleanup = async () => {
    events.push("cleanup");
  };
  Factory.savePdfAsAttachment = async () => {
    events.push("import");
    return { id: 200 };
  };
  try {
    await Factory.translateSingleItem(item);
    assert.ok(events.indexOf("import") < events.indexOf("cleanup"));
    assert.ok(events.indexOf("cleanup") < events.indexOf("erase-note"));
    const saved = events.filter((event) => event === "save-note").length;
    await tick();
    assert.equal(events.filter((event) => event === "save-note").length, saved);
    events.length = 0;
    failing = true;
    await assert.rejects(Factory.translateSingleItem(item), /failure/);
    assert.ok(!events.includes("cleanup"));
    assert.ok(!events.includes("erase-note"));
    assert.ok(notes.at(-1).html.includes("失败"));
    assert.ok(notes.at(-1).html.includes("&lt;diagnostic&gt;"));
  } finally {
    LightweightTranslation.translate = originalTranslate;
    LightweightTranslation.cleanup = originalCleanup;
    Factory.savePdfAsAttachment = originalSave;
  }
});

test("concurrent portable TeX preparation shares one initialization and can retry after failure", async () => {
  let reads = 0;
  const gate = deferred();
  globalThis.PathUtils = { profileDir: "fixture", join: path.join };
  globalThis.Zotero = { isWin: true, Prefs: { get: () => "" } };
  globalThis.Services = { appinfo: { XPCOMABI: "x86_64-msvc" } };
  globalThis.IOUtils = {
    exists: async () => true,
    readJSON: async () => {
      reads++;
      await gate.promise;
      return {
        archive:
          "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f",
        executable: "fixture-digest",
      };
    },
    computeHexDigest: async () => "fixture-digest",
  };
  const updates = [];
  const a = ensurePortableTex((text) => updates.push(text));
  const b = ensurePortableTex((text) => updates.push(text));
  await tick();
  assert.equal(reads, 1);
  gate.resolve();
  assert.equal(await a, await b);
  assert.ok(updates.some((text) => text.includes("等待")));
  globalThis.IOUtils.readJSON = async () => {
    throw new Error("receipt fixture failure");
  };
  await assert.rejects(
    ensurePortableTex(() => {}),
    /receipt fixture/,
  );
  globalThis.IOUtils.readJSON = async () => ({
    archive: "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f",
    executable: "fixture-digest",
  });
  assert.ok(await ensurePortableTex(() => {}));
});

test("portable compilers serialize shared cache access and cancelled queued jobs never launch", async () => {
  const gate = deferred();
  let launches = 0,
    cancelled = false;
  globalThis.ChromeUtils = {
    importESModule: () => ({
      Subprocess: {
        call: async () => {
          launches++;
          return {
            stdin: { close: async () => {} },
            stdout: { readString: async () => "" },
            stderr: { readString: async () => "" },
            wait: async () => {
              await gate.promise;
              return { exitCode: 0 };
            },
          };
        },
      },
    }),
  };
  const first = LightweightTranslation.runCompiler(
    "tectonic",
    [],
    "job-one",
    "cache",
    () => {},
    () => {},
  );
  const second = LightweightTranslation.runCompiler(
    "tectonic",
    [],
    "job-two",
    "cache",
    () => {},
    () => {
      if (cancelled) throw new Error("cancelled");
    },
  );
  const rejected = assert.rejects(second, /cancelled/);
  await tick();
  assert.equal(launches, 1);
  cancelled = true;
  gate.resolve();
  await first;
  await rejected;
  assert.equal(launches, 1);
});

test("existing translations open beside the available original and fall back to a single reader", async () => {
  const translation = { id: 5 };
  const attachments = [
    { id: 2, attachmentContentType: "text/html" },
    {
      id: 3,
      attachmentContentType: "application/pdf",
      attachmentFilename: "missing.pdf",
      getField: () => "Original missing",
      fileExists: async () => false,
    },
    {
      id: 4,
      attachmentContentType: "application/pdf",
      attachmentFilename: "other_hjfy_arxiv_2610.34593v2.pdf",
    },
    {
      id: 6,
      attachmentContentType: "application/pdf",
      attachmentFilename: "original.pdf",
      getField: () => "Original",
      fileExists: async () => true,
    },
  ];
  const calls = [];
  const parent = {
    getBestAttachment: async () => translation,
    getAttachments: () => attachments.map((attachment) => attachment.id),
  };
  globalThis.Zotero = {
    Items: {
      get: (id) => attachments.find((attachment) => attachment.id === id),
    },
    Reader: {
      open: async (id, location, options) => {
        calls.push({ id, location, options });
        throw new Error("New tab requested");
      },
    },
  };
  await assert.rejects(
    openTranslationReaders(parent, translation),
    /New tab requested/,
  );
  assert.deepEqual(calls, [
    { id: 6, location: undefined, options: { allowDuplicate: true } },
  ]);
  globalThis.Zotero.Reader.open = async (id, location, options) => {
    calls.push({ id, location, options });
  };
  attachments.pop();
  calls.length = 0;
  assert.match(
    await openTranslationReaders(parent, translation),
    /未找到本地原文/,
  );
  assert.deepEqual(calls, [{ id: 5, location: undefined, options: undefined }]);
});

test("opening an existing translation bypasses a busy queue and never creates or updates a log note", async () => {
  const translated = {
    id: 75,
    attachmentFilename: "Paper_hjfy_arxiv_2610.34593v1.pdf",
    fileExists: async () => true,
  };
  const parent = {
    isRegularItem: () => true,
    getDisplayTitle: () => "Paper",
    getField: (name) =>
      name === "url" ? "https://arxiv.org/abs/2610.34593v1" : "",
    getAttachments: () => [75],
    getBestAttachment: async () => translated,
  };
  let opened = 0;
  globalThis.Zotero = {
    Items: { get: () => translated },
    Item: class {
      constructor() {
        assert.fail("Must not create a log note");
      }
    },
    Reader: {
      open: async (id) => {
        assert.equal(id, 75);
        opened++;
      },
    },
  };
  const gate = deferred();
  const original = Factory.translateItem;
  const blockers = [];
  try {
    Factory.translateItem = () => gate.promise;
    for (const id of [801, 802])
      blockers.push(
        Factory.translateSingleItem({
          id,
          libraryID: 910,
          isRegularItem: () => true,
          getField: () => "",
          getDisplayTitle: () => `Busy ${id}`,
        }),
      );
    await tick();
    Factory.translateItem = original;
    for (let i = 0; i < 2; i++) {
      let result;
      const opening = Factory.translateSingleItem(parent).then((item) => {
        result = item;
      });
      await tick();
      assert.equal(result, translated);
      await opening;
    }
    assert.equal(opened, 2);
  } finally {
    gate.resolve();
    await Promise.allSettled(blockers);
    Factory.translateItem = original;
  }
});
