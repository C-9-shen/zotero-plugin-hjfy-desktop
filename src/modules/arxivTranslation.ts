import { getString } from "../utils/locale";
import { parseArxivId, parseArxivExtra } from "../utils/arxivId";
import { DesktopTranslation } from "./desktopTranslation";
import { LightweightTranslation } from "./lightweightTranslation";
import { getPref } from "../utils/prefs";
import { TranslationProgressNote } from "./translationProgressNote";
import { openTranslationReaders } from "./translationReader";
import {
  openTranslationTaskList,
  runTranslationTask,
} from "./translationTasks";

export class ArxivTranslationFactory {
  /**
   * 注册右键菜单项
   */
  static registerRightClickMenuItem() {
    const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-itemmenu-hjfy-arxiv-translate",
      label: getString("menuitem-label"),
      commandListener: () => {
        const items = ztoolkit.getGlobal("ZoteroPane").getSelectedItems();
        if (items.length > 0) {
          openTranslationTaskList();
          this.translateSelectedItems(items);
        } else {
          new ztoolkit.ProgressWindow(getString("menuitem-label"))
            .createLine({
              text: "未选择任何条目",
              type: "warning",
            })
            .show()
            .startCloseTimer(3000);
        }
      },
      icon: menuIcon,
    });
  }

  /**
   * 翻译选中的条目
   */
  static async translateSelectedItems(items: Zotero.Item[]) {
    await Promise.all(
      items.map(async (item) => {
        if (!addon.data.alive) return;
        try {
          await this.translateSingleItem(item);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          ztoolkit.log("本地翻译失败", message);
        }
      }),
    );
  }

  static async translateSingleItem(
    item: Zotero.Item,
    update: (text: string) => void = () => {},
  ) {
    const existing = await this.openExistingTranslation(item, update);
    if (existing) return existing;
    return runTranslationTask(
      item,
      (report) => this.translateItem(item, report),
      update,
    );
  }

  private static async translateItem(
    item: Zotero.Item,
    update: (text: string) => void,
  ) {
    if (!item.isRegularItem()) throw new Error("请选择文献条目进行翻译。");
    const arxivId = this.extractArxivIdFromItem(item);
    // A queued item may have gained a translation while waiting.
    const existing = await this.openExistingTranslation(item, update);
    if (existing) return existing;
    const progress = await TranslationProgressNote.create(item);
    const report = (text: string) => {
      progress.update(text);
      update(text);
    };
    try {
      if (!arxivId)
        throw new Error("未找到有效的 arXiv ID（需要 DOI、URL 或存档 ID）。");
      report(`arXiv：${arxivId}`);
      const backend =
        getPref("translation.backend") === "lightweight"
          ? LightweightTranslation
          : DesktopTranslation;
      const output = await backend.translate(arxivId, report, (text) =>
        progress.log(text),
      );
      report("正在添加翻译附件…");
      const attachment = await this.savePdfAsAttachment(item, output, arxivId);
      await backend.cleanup(output);
      await progress.remove();
      report("翻译已完成，PDF 已添加到当前文献附件。");
      return attachment;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await progress
        .finish("失败", message)
        .catch((noteError) => Zotero.logError(noteError));
      throw error;
    }
  }

  private static async openExistingTranslation(
    item: Zotero.Item,
    update: (text: string) => void,
  ) {
    if (!item.isRegularItem()) return null;
    const arxivId = this.extractArxivIdFromItem(item);
    if (!arxivId) return null;
    const existing = await this.findExistingTranslationAttachment(
      item,
      this.getTranslationAttachmentFilename(item, arxivId),
    );
    if (existing) update(await openTranslationReaders(item, existing));
    return existing;
  }

  static extractArxivIdFromItem(item: Zotero.Item): string | null {
    const candidates = [
      parseArxivId(this.extractDOI(item) || ""),
      parseArxivId(String(item.getField("url") || "")),
      parseArxivId(String(item.getField("archiveID") || "")),
      parseArxivExtra(String(item.getField("extra") || "")),
    ].filter((id): id is string => Boolean(id));
    const first = candidates[0];
    if (!first) return null;
    // Prefer an explicit version of the same paper over its unversioned DOI.
    return (
      candidates.find(
        (id) =>
          id.replace(/v\d+$/, "") === first.replace(/v\d+$/, "") &&
          /v\d+$/.test(id),
      ) || first
    );
  }

  static extractArxivIdFromUrl(url: string): string | null {
    return parseArxivId(url);
  }

  static extractArxivIdFromArchiveId(id: string): string | null {
    return parseArxivId(id);
  }

  static extractArxivIdFromExtra(extra: string): string | null {
    return parseArxivExtra(extra);
  }

  /**
   * 从条目中提取 DOI
   */
  static extractDOI(item: Zotero.Item): string | null {
    // 尝试从 DOI 字段获取
    let doi = item.getField("DOI") as string;

    // 如果 DOI 字段为空，尝试从 URL 字段解析
    if (!doi) {
      const url = item.getField("url") as string;
      if (url && url.includes("doi.org/")) {
        doi = url.split("doi.org/")[1];
      }
    }

    // 如果仍然为空，尝试从 extra 字段解析
    if (!doi) {
      const extra = item.getField("extra") as string;
      if (extra) {
        const doiMatch = extra.match(/DOI:\s*(10\.\d+\/[^\s]+)/i);
        if (doiMatch) {
          doi = doiMatch[1];
        }
      }
    }

    return doi ? doi.trim() : null;
  }

  /**
   * 从 DOI 中提取 arXiv ID
   */
  static extractArxivId(doi: string): string | null {
    return parseArxivId(doi);
  }

  static async savePdfAsAttachment(
    item: Zotero.Item,
    outputPath: string,
    arxivId: string,
  ): Promise<Zotero.Item> {
    const filename = this.getTranslationAttachmentFilename(item, arxivId);
    const copyPath = PathUtils.join(PathUtils.parent(outputPath)!, filename);
    await IOUtils.copy(outputPath, copyPath);
    try {
      const attachment = await Zotero.Attachments.importFromFile({
        file: copyPath,
        parentItemID: item.id,
      });
      attachment.setField(
        "title",
        `幻觉翻译 - ${item.getDisplayTitle()} (${arxivId})`,
      );
      await attachment.saveTx();
      return attachment;
    } finally {
      await IOUtils.remove(copyPath, { ignoreAbsent: true });
    }
  }

  /**
   * 获取翻译附件的文件名
   */
  static getTranslationAttachmentFilename(
    item: Zotero.Item,
    arxivId: string,
  ): string {
    const title = item
      .getDisplayTitle()
      .replace(/[^\w\s.-]/g, "")
      .substring(0, 50);
    return `${title}_hjfy_arxiv_${arxivId.replace(/\//g, "_")}.pdf`;
  }

  /**
   * 获取附件文件名（兼容 Zotero 7/8/9）
   */
  static getAttachmentFilename(attachment: Zotero.Item): string | null {
    // Zotero 9.0+: 使用 attachmentFilename 属性
    if ("attachmentFilename" in attachment) {
      return (attachment as any).attachmentFilename || null;
    }
    // Zotero 7/8: 使用 getFilename() 方法
    if (typeof (attachment as any).getFilename === "function") {
      return (attachment as any).getFilename() || null;
    }
    return null;
  }

  /**
   * 查找已存在的翻译附件
   */
  static async findExistingTranslationAttachment(
    item: Zotero.Item,
    filename: string,
  ): Promise<Zotero.Item | null> {
    const attachmentIDs = item.getAttachments();

    for (const attachmentID of attachmentIDs) {
      const attachment = Zotero.Items.get(attachmentID) as Zotero.Item | null;
      if (!attachment) {
        continue;
      }

      const existingFilename = this.getAttachmentFilename(attachment);
      const fileExists =
        typeof (attachment as any).fileExists === "function"
          ? await (attachment as any).fileExists()
          : false;

      if (existingFilename === filename && fileExists) {
        return attachment;
      }
    }

    return null;
  }
}
