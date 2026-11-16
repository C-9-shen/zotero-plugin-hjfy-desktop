import { assert } from "chai";
import { ArxivTranslationFactory } from "../src/modules/arxivTranslation";
import {
  openTranslationTaskList,
  closeTranslationTaskList,
  translationTaskSnapshot,
} from "../src/modules/translationTasks";

describe("translation task list", function () {
  this.timeout(15000);

  it("shows running and queued jobs, accepts another batch and renders completion", async function () {
    (globalThis as any).addon = (Zotero as any).HjfyArxiv;
    (globalThis as any).ztoolkit = (Zotero as any).HjfyArxiv.data.ztoolkit;
    const original = (ArxivTranslationFactory as any).translateItem;
    const items: Zotero.Item[] = [];
    const release: (() => void)[] = [];
    let jobs: Promise<void>[] = [];
    try {
      for (let i = 0; i < 3; i++) {
        const item = new Zotero.Item("preprint");
        item.setField("title", `Queue UI fixture ${i}`);
        await item.saveTx();
        items.push(item);
      }
      (ArxivTranslationFactory as any).translateItem = async (
        _item: Zotero.Item,
        update: (text: string) => void,
      ) => {
        update("fixture translation in progress");
        await new Promise<void>((resolve) => release.push(resolve));
      };
      const win = openTranslationTaskList()!;
      jobs = [
        ArxivTranslationFactory.translateSelectedItems(items.slice(0, 2)),
        ArxivTranslationFactory.translateSelectedItems(items.slice(2)),
      ];
      for (let i = 0; i < 50; i++) {
        if (
          win.document
            .getElementById("hjfy-task-list")
            ?.textContent?.includes("排队中")
        )
          break;
        await Zotero.Promise.delay(100);
      }
      const content =
        win.document.getElementById("hjfy-task-list")!.textContent!;
      assert.include(content, "排队中");
      assert.include(content, "运行中");
      assert.include(content, "Queue UI fixture 2");
      assert.lengthOf(release, 2);
      release[0]();
      for (let i = 0; i < 50 && release.length < 3; i++)
        await Zotero.Promise.delay(20);
      assert.lengthOf(release, 3);
      for (const done of release) done();
      await Promise.all(jobs);
      assert.include(
        win.document.getElementById("hjfy-task-list")!.textContent!,
        "已完成",
      );
      for (const item of items)
        assert.equal(
          translationTaskSnapshot().find(
            (task) => task.key === `${item.libraryID}:${item.id}`,
          )!.status,
          "已完成",
        );
    } finally {
      for (const done of release) done();
      await Promise.allSettled(jobs);
      closeTranslationTaskList();
      (ArxivTranslationFactory as any).translateItem = original;
      for (const item of items) await Zotero.Items.erase(item.id);
    }
  });
});
