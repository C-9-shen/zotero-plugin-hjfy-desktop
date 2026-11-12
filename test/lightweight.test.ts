import { assert } from "chai";
import { ArxivTranslationFactory } from "../src/modules/arxivTranslation";
import { LightweightTranslation } from "../src/modules/lightweightTranslation";
import { TECTONIC_URL } from "../src/modules/latex/portableTex";

describe("independent lightweight LaTeX backend", function () {
  this.timeout(240000);

  it("runs a local API and portable TeX without desktop software, shell scripts or system TeX", async function () {
    const archive = Services.env.get("HJFY_TEST_TECTONIC_ARCHIVE");
    const texCache = Services.env.get("HJFY_TEST_TEX_CACHE");
    const baseUrl = Services.env.get("HJFY_TEST_LITE_BASE_URL");
    if (!archive || !texCache || !baseUrl) return this.skip();
    const prefRoot = "extensions.zotero.hjfyarxiv.";
    const prefs = {
      "translation.backend": "lightweight",
      "lightweight.baseUrl": baseUrl,
      "lightweight.protocol": "chat-completions",
      "lightweight.model": "mock-latex",
      "lightweight.tectonicPath": "",
      "lightweight.mainFile": "",
      "desktop.installationDirectory": "C:\\does-not-exist",
    };
    const previous = Object.fromEntries(
      Object.keys(prefs).map((name) => [
        name,
        Zotero.Prefs.get(prefRoot + name, true),
      ]),
    );
    const originalDownload = Zotero.File.download;
    const originalPath = Services.env.get("PATH");
    const testRoot = PathUtils.join(PathUtils.profileDir, "hjfy-lightweight");
    const item = new Zotero.Item("preprint");
    item.setField("title", "Lightweight integration");
    item.setField("url", "https://arxiv.org/abs/2610.34593v1");
    await item.saveTx();
    let downloads = 0;
    const logins = Services.logins.findLogins(
      "chrome://hjfyarxiv",
      null as any,
      "lightweight-api",
    );
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo,
    );
    login.init(
      "chrome://hjfyarxiv",
      null as any,
      "lightweight-api",
      "api-key",
      "hjfy-local-fixture",
      "",
      "",
    );
    try {
      for (const previous of logins) Services.logins.removeLogin(previous);
      await Services.logins.addLoginAsync(login);
      for (const [name, value] of Object.entries(prefs))
        Zotero.Prefs.set(prefRoot + name, value, true);
      await IOUtils.makeDirectory(testRoot, { createAncestors: true });
      if (!(await IOUtils.exists(PathUtils.join(testRoot, "tex-cache"))))
        await IOUtils.copy(texCache, PathUtils.join(testRoot, "tex-cache"), {
          recursive: true,
        });
      Zotero.File.download = async (url, destination) => {
        if (url === TECTONIC_URL) {
          downloads++;
          await IOUtils.copy(archive, destination);
        } else {
          assert.equal(url, "https://arxiv.org/src/2610.34593v1");
          await IOUtils.writeUTF8(
            destination as string,
            String.raw`\documentclass{article}
\title{A useful paper}
\author{Alice Smith}
\begin{document}
\maketitle
\section{Introduction}
We study $x^2$ and \label{sec:test} useful results.

Another paragraph with \ref{sec:test}.
\end{document}`,
          );
        }
      };
      // The selected backend must never consult the desktop installation/config.
      Zotero.Prefs.set(
        prefRoot + "desktop.installationDirectory",
        "C:\\does-not-exist",
        true,
      );
      Services.env.set("PATH", "");
      const before = JSON.parse(
        (await Zotero.HTTP.request("GET", baseUrl.replace(/\/v1$/, "/stats")))
          .responseText || "{}",
      ).calls;
      const attachment =
        await ArxivTranslationFactory.translateSingleItem(item);
      assert.equal(attachment.parentID, item.id);
      assert.isTrue(await attachment.fileExists());
      assert.lengthOf(item.getNotes(), 1);
      const note = Zotero.Items.get(item.getNotes()[0]);
      assert.include(note.getNote(), "已完成");
      assert.include(note.getNote(), "正文翻译");
      assert.notInclude(note.getNote(), "hjfy-local-fixture");
      const after = JSON.parse(
        (await Zotero.HTTP.request("GET", baseUrl.replace(/\/v1$/, "/stats")))
          .responseText || "{}",
      ).calls;
      assert.isAbove(after, before);
      // Re-running the engine itself exercises disk cache without duplicate imports.
      const cached = await LightweightTranslation.translate(
        "2610.34593v1",
        () => {},
      );
      assert.isTrue(await IOUtils.exists(cached));
      const cachedCalls = JSON.parse(
        (await Zotero.HTTP.request("GET", baseUrl.replace(/\/v1$/, "/stats")))
          .responseText || "{}",
      ).calls;
      assert.equal(cachedCalls, after);
      assert.isAtMost(downloads, 1);
      const savedNote = note.getNote();
      const readerOpen = Zotero.Reader.open;
      Zotero.Reader.open = (async () => {}) as any;
      try {
        const reopened =
          await ArxivTranslationFactory.translateSingleItem(item);
        assert.equal(reopened.id, attachment.id);
        assert.lengthOf(item.getAttachments(), 1);
        assert.deepEqual(item.getNotes(), [note.id]);
        assert.equal(note.getNote(), savedNote);
      } finally {
        Zotero.Reader.open = readerOpen;
      }
    } catch (error) {
      await IOUtils.writeJSON(
        PathUtils.join(PathUtils.profileDir, "hjfy-lightweight-error.json"),
        { error: String(error), stack: (error as Error).stack },
      );
      throw new Error(String(error));
    } finally {
      Services.env.set("PATH", originalPath);
      Zotero.File.download = originalDownload;
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) Zotero.Prefs.clear(prefRoot + name, true);
        else Zotero.Prefs.set(prefRoot + name, value, true);
      }
      for (const current of Services.logins.findLogins(
        "chrome://hjfyarxiv",
        null as any,
        "lightweight-api",
      ))
        Services.logins.removeLogin(current);
      for (const previous of logins)
        await Services.logins.addLoginAsync(previous);
      await Zotero.Items.erase(item.id);
    }
  });
});
