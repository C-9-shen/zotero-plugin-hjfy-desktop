import { assert } from "chai";
import { ArxivTranslationFactory } from "../src/modules/arxivTranslation";
import { DesktopTranslation } from "../src/modules/desktopTranslation";

describe("translation progress child notes", function () {
  this.timeout(15000);
  let item: Zotero.Item;
  let originalTranslate: typeof DesktopTranslation.translate;

  beforeEach(async function () {
    (globalThis as any).addon = (Zotero as any).HjfyArxiv;
    originalTranslate = DesktopTranslation.translate;
    item = new Zotero.Item("preprint");
    item.setField("title", "Translation progress note test");
    item.setField("url", "https://arxiv.org/abs/2610.34593v1");
    await item.saveTx();
  });

  afterEach(async function () {
    DesktopTranslation.translate = originalTranslate;
    if (item.id) await Zotero.Items.erase(item.id);
  });

  it("updates a child note during translation and preserves failure diagnostics as escaped text", async function () {
    DesktopTranslation.translate = async (_id, update, log) => {
      assert.lengthOf(item.getNotes(), 1);
      const note = Zotero.Items.get(item.getNotes()[0]);
      assert.equal(note.parentID, item.id);
      assert.equal(note.libraryID, item.libraryID);
      assert.include(note.getNote(), "进行中");
      update("正在翻译：2/10（main.tex）");
      log?.('模型日志：<script> & "quote"\n第二行');
      await Zotero.Promise.delay(1400);
      assert.include(note.getNote(), "2/10");
      assert.include(note.getNote(), "模型日志：&lt;script&gt; &amp;");
      assert.notInclude(note.getNote(), "<script>");
      throw new Error("测试翻译失败：<error>；诊断目录：C:\\test");
    };
    let failure: unknown;
    try {
      await ArxivTranslationFactory.translateSingleItem(item);
    } catch (error) {
      failure = error;
    }
    assert.include(String(failure), "测试翻译失败");
    const note = Zotero.Items.get(item.getNotes()[0]);
    const content = note.getNote();
    assert.include(content, "幻觉翻译日志 · 失败");
    assert.include(content, "arXiv：2610.34593v1");
    assert.include(content, "&lt;error&gt;");
    assert.include(content, "诊断目录");
    assert.include(content, "2/10");
    await Zotero.Promise.delay(1200);
    assert.equal(note.getNote(), content);
  });

  it("records validation failures before launching the engine", async function () {
    item.setField("url", "");
    await item.saveTx();
    DesktopTranslation.translate = async () => {
      throw new Error("Engine must not run without an arXiv ID");
    };
    try {
      await ArxivTranslationFactory.translateSingleItem(item);
      assert.fail("Expected an invalid arXiv ID error");
    } catch (error) {
      assert.include(String(error), "未找到有效的 arXiv ID");
    }
    assert.lengthOf(item.getNotes(), 1);
    assert.include(
      Zotero.Items.get(item.getNotes()[0]).getNote(),
      "幻觉翻译日志 · 失败",
    );
  });

  it("erases the successful progress note after import without recreating it on a timer", async function () {
    const originalSave = ArxivTranslationFactory.savePdfAsAttachment;
    DesktopTranslation.translate = async (_id, update, log) => {
      assert.lengthOf(item.getNotes(), 1);
      update("正文翻译 2/2");
      log?.("编译完成");
      return "test-output.pdf";
    };
    ArxivTranslationFactory.savePdfAsAttachment = async () => {
      assert.lengthOf(item.getNotes(), 1);
      return item;
    };
    try {
      await ArxivTranslationFactory.translateSingleItem(item);
      assert.lengthOf(item.getNotes(), 0);
      await Zotero.Promise.delay(1200);
      assert.lengthOf(item.getNotes(), 0);
    } finally {
      ArxivTranslationFactory.savePdfAsAttachment = originalSave;
    }
  });
});
