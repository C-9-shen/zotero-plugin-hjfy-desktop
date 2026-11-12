import { setupReaderSync } from "./readerSync";

interface SplitTab {
  tabID: string;
  win: _ZoteroTypes.MainWindow;
  ready: Promise<void>;
  closed: boolean;
}

const splitTabs = new Map<number, SplitTab>();

export function closeTranslationReaders(win?: Window) {
  for (const state of [...splitTabs.values()]) {
    if (!win || state.win === win) state.win.Zotero_Tabs.close(state.tabID);
  }
}

async function waitFor<T>(
  state: SplitTab,
  check: () => T,
): Promise<NonNullable<T>> {
  for (let i = 0; i < 200; i++) {
    if (state.closed || state.win.closed) throw new Error("分屏标签页已关闭。");
    const result = check();
    if (result) return result;
    await Zotero.Promise.delay(100);
  }
  throw new Error("分屏阅读器加载超时，请关闭标签页后重试。");
}

async function getAnnotations(item: Zotero.Item) {
  return Promise.all(
    item.getAnnotations().map(async (annotation) => {
      const json: any = await Zotero.Annotations.toJSON(annotation);
      json.id = annotation.key;
      delete json.key;
      for (const key in json) {
        if (!Array.isArray(json[key])) json[key] = json[key] || "";
      }
      json.tags ||= [];
      return json;
    }),
  );
}

// Embedded reader approach adapted from Infinity4B/zotero-hjfy-split-reader
// (AGPL-3.0-or-later). Keep the original iframe in place to preserve its state.
async function embedTranslation(
  host: _ZoteroTypes.ReaderInstance,
  translation: Zotero.Item,
  state: SplitTab,
) {
  const win = state.win;
  const doc = win.document;
  const container = doc.getElementById(state.tabID)! as HTMLElement;
  container.classList.add("hjfy-split-readers");
  container.style.cssText +=
    ";display:flex;flex-direction:row;min-height:0;overflow:hidden";
  const original = host._iframe!;
  original.style.cssText += ";flex:1 1 0;min-width:200px;width:0;height:100%";
  const splitter = doc.createXULElement("splitter") as XULElement;
  splitter.setAttribute("collapse", "none");
  splitter.style.cssText = "width:5px;min-width:5px;cursor:ew-resize";
  const browser = doc.createXULElement("browser") as XULBrowserElement;
  browser.setAttribute("type", "content");
  browser.setAttribute("transparent", "true");
  browser.setAttribute("class", "reader hjfy-translation-reader");
  browser.setAttribute("flex", "1");
  browser.setAttribute("src", "resource://zotero/reader/reader.html");
  browser.style.cssText = "flex:1 1 0;min-width:200px;width:0;height:100%";
  original.after(splitter, browser);
  const popupset = doc.createXULElement("popupset");
  container.appendChild(popupset);
  let wrapped: any = null;
  let observer: string | undefined = undefined;
  let contentWin: any = null;
  let sync: ReturnType<typeof setupReaderSync> | undefined = undefined;
  const nativeContextMenu = (host as any)._openContextMenu;
  (host as any)._openContextMenu = (params: any) =>
    nativeContextMenu.call(host, {
      ...params,
      itemGroups: [
        ...params.itemGroups,
        ...(sync ? [sync.menuItems("left")] : []),
      ],
    });
  const addToNote = (annotations: any[]) =>
    (host as any)._addToNote.call(
      { _item: translation, _window: win },
      annotations,
    );
  const eventBridge = (event: any) => {
    if (state.closed) return;
    const data = event.detail?.wrappedJSObject;
    if (!data) return;
    const append = data.append;
    if (typeof append === "function") {
      data.append = (...args: any[]) => append(...clone(args));
    }
    data.reader = {
      tabID: state.tabID,
      itemID: translation.id,
      _item: translation,
      _iframeWindow: contentWin,
      _instanceID: `hjfy-${state.tabID}-translation`,
      _internalReader: wrapped._reader,
      _addToNote: addToNote,
    };
    (Zotero.Reader as any)._dispatchEvent(data);
  };
  const clone = (value: any) =>
    Components.utils.cloneInto(value, contentWin, {
      wrapReflectors: true,
      cloneFunctions: true,
    });
  const tab = (win.Zotero_Tabs as any)._getTab(state.tabID).tab;
  const originalClose = tab.onClose;
  tab.onClose = () => {
    state.closed = true;
    if (splitTabs.get(translation.id) === state)
      splitTabs.delete(translation.id);
    if (observer) Zotero.Notifier.unregisterObserver(observer);
    sync?.destroy();
    (host as any)._openContextMenu = nativeContextMenu;
    contentWin?.removeEventListener("customEvent", eventBridge);
    wrapped?._reader?.uninit?.();
    popupset.remove();
    originalClose?.call(tab);
  };

  await waitFor(
    state,
    () => browser.contentWindow?.wrappedJSObject?.createReader,
  );
  contentWin = browser.contentWindow;
  wrapped = contentWin.wrappedJSObject;
  contentWin.addEventListener("customEvent", eventBridge);
  const ftl = ["zotero.ftl", "reader.ftl"].map((name) =>
    Zotero.File.getContentsFromURL(`chrome://zotero/locale/${name}`),
  );
  const openContextMenu = () => {
    const params = wrapped.contextMenuParams;
    if (!params) return;
    const popup = doc.createXULElement("menupopup") as XULPopupElement;
    const populate = (menu: any, groups: any[][]) => {
      for (const group of groups) {
        if (menu.childElementCount)
          menu.appendChild(doc.createXULElement("menuseparator"));
        for (const item of group) {
          const entry = doc.createXULElement(
            item.itemGroups ? "menu" : "menuitem",
          );
          entry.setAttribute("label", item.label || "");
          if (item.disabled) entry.setAttribute("disabled", "true");
          if (item.checked !== undefined) {
            entry.setAttribute("type", "checkbox");
            entry.setAttribute("checked", String(item.checked));
          }
          if (item.itemGroups) {
            const child = doc.createXULElement("menupopup");
            entry.appendChild(child);
            populate(child, item.itemGroups);
          } else entry.addEventListener("command", () => item.onCommand?.());
          menu.appendChild(entry);
        }
      }
    };
    populate(popup, params.itemGroups);
    if (sync) populate(popup, [sync.menuItems("right")]);
    popupset.appendChild(popup);
    popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
    const rect = browser.getBoundingClientRect();
    popup.openPopupAtScreen(
      win.mozInnerScreenX + rect.x + params.x,
      win.mozInnerScreenY + rect.y + params.y,
      true,
    );
  };
  wrapped.createReader(
    clone({
      type: "pdf",
      data: {
        url: `zotero://attachment/${Zotero.API.getLibraryPrefix(translation.libraryID)}/items/${translation.key}/`,
      },
      annotations: await getAnnotations(translation),
      readOnly: !translation.isEditable(),
      authorName:
        translation.library.libraryType === "group"
          ? Zotero.Users.getCurrentName()
          : "",
      sidebarWidth: 240,
      sidebarOpen: false,
      bottomPlaceholderHeight: null,
      showContextPaneToggle: false,
      contextPaneOpen: false,
      showAnnotations: true,
      rtl: (Zotero as any).rtl,
      fontSize: Zotero.Prefs.get("fontSize"),
      ftl,
      textSelectionAnnotationMode: Zotero.Prefs.get(
        "reader.textSelectionAnnotationMode",
      ),
      lightTheme: Zotero.Prefs.get("reader.lightTheme"),
      darkTheme: Zotero.Prefs.get("reader.darkTheme"),
      onOpenContextMenu: openContextMenu,
      onToggleSidebar: () => {},
      onChangeSidebarWidth: () => {},
      onChangeSidebarView: (view: string) =>
        Zotero.Prefs.set("reader.lastSidebarTab", view),
      onChangeViewState: () => {},
      onSaveAnnotations: async (annotations: any[], callback: () => void) => {
        try {
          for (const annotation of annotations) {
            annotation.key = annotation.id;
            delete annotation.authorName;
            await Zotero.Annotations.saveFromJSON(translation, annotation);
          }
        } catch (error) {
          Zotero.logError(error as Error);
          wrapped._reader.setReadOnly(true);
          throw error;
        } finally {
          callback();
        }
      },
      onDeleteAnnotations: async (ids: string[]) => {
        for (const id of ids) {
          const annotation = Zotero.Items.getByLibraryAndKey(
            translation.libraryID,
            id,
          );
          if (
            annotation &&
            annotation.isAnnotation() &&
            annotation.parentID === translation.id
          )
            await annotation.eraseTx();
        }
      },
      onAddToNote: addToNote,
      onOpenTagsPopup: () => {},
      onClosePopup: () => {},
      onOpenLink: (url: string) => Zotero.launchURL(url),
      onCopyImage: () => {},
      onSaveImageAs: () => {},
      onSetDataTransferAnnotations: () => {},
      onToggleContextPane: () => {},
    }),
  );
  await waitFor(state, () => wrapped._reader?._primaryView);
  await wrapped._reader._primaryView.initializedPromise;
  sync = setupReaderSync(
    win,
    container,
    original as XULBrowserElement,
    browser,
  );
  let annotationKeys = new Set(
    translation.getAnnotations().map((item) => item.key),
  );
  observer = Zotero.Notifier.registerObserver(
    {
      notify: async (
        event: string,
        _type: string,
        ids: (number | string)[],
      ) => {
        if (state.closed || !["add", "modify", "delete"].includes(event))
          return;
        const annotations = await getAnnotations(translation);
        const keys = new Set(annotations.map((item) => item.id));
        const removed = [...annotationKeys].filter((key) => !keys.has(key));
        if (removed.length) wrapped._reader.unsetAnnotations(clone(removed));
        if (
          ids.some(
            (id) => Zotero.Items.get(Number(id))?.parentID === translation.id,
          )
        ) {
          wrapped._reader.setAnnotations(clone(annotations));
        }
        annotationKeys = keys;
      },
    },
    ["item"],
    "hjfy-split-reader",
  );
}

/** Keep the native original reader and embed the translation in the same tab. */
export async function openTranslationReaders(
  parent: Zotero.Item,
  translation: Zotero.Item,
): Promise<string> {
  const active = splitTabs.get(translation.id);
  if (active && !active.win.closed && !active.closed) {
    active.win.Zotero_Tabs.select(active.tabID);
    await active.ready;
    return "已打开原文（左）与译文（右）分屏浏览。";
  }
  const preferred = await parent.getBestAttachment();
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...parent.getAttachments().map((id) => Zotero.Items.get(id)),
  ];
  let original: Zotero.Item | undefined;
  for (const candidate of candidates) {
    if (
      candidate &&
      candidate.id !== translation.id &&
      candidate.attachmentContentType === "application/pdf" &&
      !/_hjfy_arxiv_/i.test(candidate.attachmentFilename || "") &&
      !String(candidate.getField("title")).startsWith("幻觉翻译 -") &&
      (await candidate.fileExists())
    ) {
      original = candidate;
      break;
    }
  }
  if (!original) {
    await Zotero.Reader.open(translation.id);
    return "已有译文已打开；未找到本地原文 PDF，无法分屏。";
  }

  const host = await Zotero.Reader.open(original.id, undefined, {
    allowDuplicate: true,
  });
  if (!host?.tabID || !host._window)
    throw new Error("无法创建 Zotero 分屏标签页。");
  const state: SplitTab = {
    tabID: host.tabID,
    win: host._window as _ZoteroTypes.MainWindow,
    ready: Promise.resolve(),
    closed: false,
  };
  splitTabs.set(translation.id, state);
  state.ready = (async () => {
    try {
      await host._initPromise;
      await embedTranslation(host, translation, state);
      state.win.Zotero_Tabs.rename(
        state.tabID,
        `${parent.getDisplayTitle()} · 原文 / 译文`,
      );
    } catch (error) {
      if (splitTabs.get(translation.id) === state)
        splitTabs.delete(translation.id);
      state.win.Zotero_Tabs.close(state.tabID);
      throw error;
    }
  })();
  await state.ready;
  return "已在新标签页内打开原文（左）与译文（右）分屏浏览。";
}
