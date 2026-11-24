import { assert } from "chai";
import { ArxivTranslationFactory } from "../src/modules/arxivTranslation";
import { DesktopTranslation } from "../src/modules/desktopTranslation";
import {
  findDesktopInstallation,
  prepareDesktopTask,
} from "../src/modules/desktopRuntime";
import { readSourceArchive } from "../src/utils/sourceArchive";

describe("desktop runtime without shell scripts", function () {
  this.timeout(240000);

  afterEach(async function () {
    const error = (this.currentTest as any)?.err;
    if (error) {
      await IOUtils.writeJSON(
        PathUtils.join(PathUtils.profileDir, "hjfy-native-error.json"),
        {
          test: this.currentTest?.title,
          error: String(error),
          message: error.message,
          stack: error.stack,
        },
      );
    }
  });

  it("finds the desktop engine through the registry and starts it without PATH search", async function () {
    const { Subprocess } = ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    );
    const originalPath = Services.env.get("PATH");
    try {
      Services.env.set("PATH", "");
      const installation = findDesktopInstallation();
      assert.include(installation, "WindowsApps");
      const bundled = PathUtils.join(
        installation,
        "Engines",
        "Office",
        "hjfy-office.exe",
      );
      const runtime = PathUtils.join(
        PathUtils.profileDir,
        "hjfy-desktop",
        "runtime",
        "probe",
      );
      await IOUtils.makeDirectory(runtime, { createAncestors: true });
      const engine = PathUtils.join(runtime, "hjfy-office.exe");
      await IOUtils.copy(bundled, engine);
      const process = await Subprocess.call({
        command: engine,
        arguments: ["--self-check"],
        stderr: "pipe",
      });
      await process.stdin.close();
      const read = async (pipe: any) => {
        let result = "";
        for (;;) {
          const chunk = await pipe.readString();
          if (!chunk) return result;
          result += chunk;
        }
      };
      const [stdout, , result] = await Promise.all([
        read(process.stdout),
        read(process.stderr),
        process.wait(),
      ]);
      assert.equal(result.exitCode, 0);
      assert.equal(JSON.parse(stdout).product, "hjfy-office");
    } finally {
      Services.env.set("PATH", originalPath);
    }
  });

  it("unpacks 2610.34593v1 in JavaScript, reads DPAPI credentials and imports the directly compiled PDF", async function () {
    const archive = Services.env.get("HJFY_TEST_ARCHIVE");
    const cache = Services.env.get("HJFY_TEST_CACHE");
    if (!archive || !cache) return this.skip();
    assert.isTrue(await IOUtils.exists(archive));
    assert.isTrue(await IOUtils.exists(cache));
    const originalDownload = Zotero.File.download;
    const originalPrepare = (DesktopTranslation as any).prepareTask;
    const originalPath = Services.env.get("PATH");
    let launches = 0;
    const item = new Zotero.Item("preprint");
    item.setField("title", "HJFY native integration 2610.34593v1");
    item.setField("DOI", "10.48550/arXiv.2610.34593");
    item.setField("url", "https://arxiv.org/abs/2610.34593v1");
    // Archive and translations come from the earlier real model run.
    // A dead endpoint makes unexpected cache misses fail without API billing.
    Zotero.File.download = async (url, destination) => {
      assert.equal(url, "https://arxiv.org/src/2610.34593v1");
      await IOUtils.copy(archive, destination);
    };
    (DesktopTranslation as any).prepareTask = async (
      ...args: Parameters<typeof prepareDesktopTask>
    ) => {
      const options = await prepareDesktopTask(...args);
      assert.match(options.command, /hjfy-office\.exe$/i);
      assert.isTrue(PathUtils.isAbsolute(options.command));
      assert.isAbove(options.environment.HJFY_PLUGIN_API_KEY.length, 0);
      assert.notInclude(
        options.arguments.join(" "),
        options.environment.HJFY_PLUGIN_API_KEY,
      );
      launches++;
      const baseUrl = options.arguments.indexOf("--base-url") + 1;
      options.arguments[baseUrl] = "http://127.0.0.1:1/v1";
      options.arguments.push(
        "--translation-cache",
        cache,
        "--translation-cache-db-max-chars",
        "0",
        "--auto-terminology=false",
        "--max-translation-attempts",
        "1",
        "--request-timeout",
        "1",
      );
      return options;
    };
    try {
      // Neither powershell.exe nor taskkill.exe is discoverable in this test.
      Services.env.set(
        "PATH",
        originalPath
          .split(";")
          .filter((part) => !/windows/i.test(part) || /texlive/i.test(part))
          .join(";"),
      );
      await item.saveTx();
      const messages: string[] = [];
      const attachment = await ArxivTranslationFactory.translateSingleItem(
        item,
        (text) => messages.push(text),
      );
      assert.equal(attachment.parentItemID, item.id);
      assert.include(attachment.attachmentFilename, "2610.34593v1.pdf");
      assert.isTrue(await attachment.fileExists());
      assert.isTrue(messages.some((message) => message.includes("解压")));
      assert.isTrue(messages.some((message) => message.includes("任务已完成")));
      assert.lengthOf(item.getNotes(), 0);
      const again = await ArxivTranslationFactory.translateSingleItem(item);
      assert.equal(again.id, attachment.id);
      assert.equal(launches, 1);
      assert.lengthOf(item.getAttachments(), 1);
      assert.lengthOf(item.getNotes(), 0);
      const job = messages
        .find((text) => text.startsWith("诊断目录："))!
        .slice("诊断目录：".length);
      assert.isFalse(await IOUtils.exists(job));
      assert.isTrue(await attachment.fileExists());
      await IOUtils.writeJSON(
        PathUtils.join(PathUtils.profileDir, "hjfy-native-test-result.json"),
        { job, attachment: attachment.attachmentFilename, launches },
      );
    } finally {
      Zotero.File.download = originalDownload;
      (DesktopTranslation as any).prepareTask = originalPrepare;
      Services.env.set("PATH", originalPath);
      if (item.id) await Zotero.Items.erase(item.id);
    }
  });

  it("downloads the exact arXiv version through Zotero without a helper", async function () {
    if (Services.env.get("HJFY_TEST_DOWNLOAD") !== "1") return this.skip();
    const directory = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "hjfy-download-",
    );
    try {
      const archive = PathUtils.join(directory, "source.download");
      await Zotero.File.download("https://arxiv.org/src/2610.34593v1", archive);
      const entries = readSourceArchive(await IOUtils.read(archive));
      assert.isTrue(entries.some((entry) => entry.path === "main.tex"));
      assert.equal(
        entries.filter((entry) => entry.path.endsWith(".tex")).length,
        11,
      );
    } finally {
      await IOUtils.remove(directory, { recursive: true });
    }
  });
});
