function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]!;
  });
}

export class TranslationProgressNote {
  private status = "进行中";
  private current = "正在准备翻译…";
  private started = new Date().toLocaleString();
  private entries: string[] = [];
  private omitted = 0;
  private timers = ChromeUtils.importESModule(
    "resource://gre/modules/Timer.sys.mjs",
  );
  private timer?: number;
  private pending: Promise<void> = Promise.resolve();
  private finished = false;

  private constructor(private note: Zotero.Item) {}

  static async create(parent: Zotero.Item) {
    const note = new Zotero.Item("note");
    note.libraryID = parent.libraryID;
    note.parentID = parent.id;
    const progress = new TranslationProgressNote(note);
    progress.update(progress.current);
    await progress.flush();
    return progress;
  }

  update(text: string) {
    if (this.finished) return;
    this.current = text;
    this.log(text);
  }

  log(text: string) {
    if (this.finished || !text.trim()) return;
    this.entries.push(`[${new Date().toLocaleTimeString()}] ${text}`);
    // Keep long-running jobs responsive in Zotero's note editor.
    if (this.entries.length > 1000) {
      this.omitted += this.entries.length - 1000;
      this.entries = this.entries.slice(-1000);
    }
    if (!this.timer) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch((error) => Zotero.logError(error));
      }, 1000);
    }
  }

  async finish(status: string, message: string) {
    this.status = status;
    this.update(message);
    this.finished = true;
    await this.flush();
  }

  async remove() {
    this.finished = true;
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.pending;
    await this.note.eraseTx();
  }

  private flush(): Promise<void> {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const html = `<div data-schema-version="9">
      <h1>幻觉翻译日志 · ${escapeHtml(this.status)}</h1>
      <p>开始时间：${escapeHtml(this.started)}</p>
      <p>当前状态：${escapeHtml(this.current)}</p>
      <h2>进度与日志</h2>
      ${this.omitted ? `<p>仅显示最近 1000 条日志，已省略 ${this.omitted} 条。</p>` : ""}
      ${this.entries.map((entry) => `<p>${escapeHtml(entry).replace(/\r?\n/g, "<br>")}</p>`).join("")}
    </div>`;
    const save = this.pending.then(async () => {
      this.note.setNote(html);
      await this.note.saveTx();
    });
    // Serialize saves; a failed periodic save must not block the final update.
    this.pending = save.catch(() => {});
    return save;
  }
}
