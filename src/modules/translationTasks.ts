import { TaskQueue } from "../utils/taskQueue";

type TaskStatus = "排队中" | "运行中" | "已完成" | "失败";
interface TranslationTask {
  key: string;
  title: string;
  status: TaskStatus;
  progress: string;
}

const queue = new TaskQueue(2);
const tasks = new Map<string, TranslationTask>();
let taskWindow: Window | undefined;

export function translationTaskSnapshot() {
  return [...tasks.values()].map((task) => ({ ...task }));
}

export function runTranslationTask<T>(
  item: Zotero.Item,
  work: (report: (text: string) => void) => Promise<T>,
  update: (text: string) => void,
): Promise<T> {
  const key = `${item.libraryID}:${item.id}`;
  const previous = tasks.get(key);
  if (
    !previous ||
    (previous.status !== "排队中" && previous.status !== "运行中")
  ) {
    tasks.set(key, {
      key,
      title: item.getDisplayTitle() || "未命名文献",
      status: "排队中",
      progress: "等待空闲任务槽位…",
    });
    renderTaskList();
  }
  return queue.run(key, async () => {
    const task = tasks.get(key)!;
    try {
      if (!addon.data.alive) throw new Error("翻译任务已取消。");
      task.status = "运行中";
      task.progress = "正在准备翻译…";
      renderTaskList();
      const result = await work((text) => {
        task.progress = text;
        renderTaskList();
        update(text);
      });
      task.status = "已完成";
      task.progress = "可从文献条目打开译文。";
      return result;
    } catch (error) {
      task.status = "失败";
      task.progress = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      renderTaskList();
    }
  });
}

function renderTaskList() {
  if (!taskWindow || taskWindow.closed) return;
  const doc = taskWindow.document;
  const container = doc.getElementById("hjfy-task-list");
  if (!container) return;
  container.replaceChildren();
  const rows = translationTaskSnapshot();
  const summary = doc.getElementById("hjfy-task-summary");
  if (summary)
    summary.textContent = `同时处理最多 2 篇；运行 ${rows.filter((t) => t.status === "运行中").length}，排队 ${rows.filter((t) => t.status === "排队中").length}。成功任务自动删除日志，失败日志保留在文献下。`;
  if (!rows.length) {
    container.textContent = "暂无任务。选中文献并执行翻译即可加入队列。";
    return;
  }
  const element = (tag: string) =>
    doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement;
  const table = element("table");
  table.style.cssText =
    "width:100%;border-collapse:collapse;table-layout:fixed";
  const header = element("thead");
  const head = element("tr");
  header.append(head);
  table.append(header);
  for (const [text, width] of [
    ["文献", "30%"],
    ["状态", "12%"],
    ["当前进度", "58%"],
  ]) {
    const cell = element("th");
    cell.textContent = text;
    cell.style.cssText = `text-align:left;padding:8px;width:${width};border-bottom:1px solid GrayText`;
    head.append(cell);
  }
  const body = element("tbody");
  table.append(body);
  for (const task of rows) {
    const row = element("tr");
    body.append(row);
    for (const text of [task.title, task.status, task.progress]) {
      const cell = element("td");
      row.append(cell);
      cell.textContent = text;
      cell.style.cssText =
        "padding:8px;vertical-align:top;overflow-wrap:anywhere;white-space:pre-wrap;border-bottom:1px solid GrayText";
    }
  }
  container.append(table);
}

export function openTranslationTaskList() {
  if (taskWindow && !taskWindow.closed) {
    taskWindow.focus();
    return taskWindow;
  }
  const dialog = new ztoolkit.Dialog(2, 1)
    .addCell(
      0,
      0,
      {
        tag: "p",
        namespace: "html",
        id: "hjfy-task-summary",
        styles: { padding: "8px", margin: "0" },
      },
      false,
    )
    .addCell(1, 0, {
      tag: "div",
      namespace: "html",
      id: "hjfy-task-list",
      styles: { overflow: "auto", padding: "8px", flex: "1", minHeight: "0" },
    })
    .addButton("清除已完成记录", "clear-completed", {
      noClose: true,
      callback: () => {
        for (const [key, task] of tasks)
          if (task.status === "已完成") tasks.delete(key);
        renderTaskList();
      },
    })
    .addButton("关闭", "close")
    .setDialogData({
      loadCallback: () => {
        taskWindow = dialog.window;
        renderTaskList();
      },
      unloadCallback: () => {
        taskWindow = undefined;
      },
    })
    .open("幻觉翻译任务列表", {
      width: 850,
      height: 480,
      resizable: true,
      fitContent: false,
      noDialogMode: true,
    });
  taskWindow = dialog.window;
  return taskWindow;
}

export function closeTranslationTaskList() {
  taskWindow?.close();
  taskWindow = undefined;
}
