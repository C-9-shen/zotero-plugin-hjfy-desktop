import { getPageProgress, getPageScrollTop } from "../utils/pageProgress";

type Side = "left" | "right";

/** Primary/follower scrolling adapted from Infinity4B/zotero-hjfy-split-reader
 * (AGPL-3.0-or-later). Use page-relative positions so zoom cannot change alignment.
 */
export function setupReaderSync(
  win: _ZoteroTypes.MainWindow,
  container: HTMLElement,
  left: XULBrowserElement,
  right: XULBrowserElement,
) {
  const panes = [left, right].map((browser) => {
    const reader = browser.contentWindow!.wrappedJSObject._reader;
    const innerWindow = reader._primaryView._iframe.contentWindow;
    const pdfWindow = innerWindow.wrappedJSObject || innerWindow;
    const scroller = pdfWindow.document.getElementById(
      "viewerContainer",
    ) as HTMLElement;
    const viewer = pdfWindow.PDFViewerApplication.pdfViewer;
    const pageBounds = () => {
      const origin = scroller.getBoundingClientRect().top + scroller.clientTop;
      return Array.from({ length: viewer.pagesCount }, (_, index) => {
        const rect = viewer.getPageView(index).div.getBoundingClientRect();
        return {
          top: rect.top - origin + scroller.scrollTop,
          height: rect.height,
        };
      });
    };
    const progress = () => getPageProgress(scroller.scrollTop, pageBounds());
    const scrollToProgress = (position: number, left = scroller.scrollLeft) =>
      scroller.scrollTo(left, getPageScrollTop(position, pageBounds()));
    return {
      browser,
      reader,
      pdfWindow,
      scroller,
      viewer,
      progress,
      scrollToProgress,
    };
  });
  let primary: Side = "right";
  let disposed = false;
  let frame = 0;
  let pauseTimer = 0;
  let paused = false;
  let ctrlPressed = false;
  let baseline = { top: 0, left: 0 };
  let alignmentOffset = 0;
  let synchronizedFollowerTop: number | undefined;
  const primaryIndex = () => (primary === "left" ? 0 : 1);
  const rememberAlignment = () => {
    alignmentOffset =
      panes[1 - primaryIndex()].progress() - panes[primaryIndex()].progress();
  };
  const alignFollower = (position: number, left?: number) => {
    const follower = panes[1 - primaryIndex()];
    follower.scrollToProgress(position, left);
    // Ignore our own scroll event. Remembering its rounded pixel position as
    // a manual adjustment would accumulate an error on every small scroll.
    synchronizedFollowerTop = follower.scroller.scrollTop;
  };
  const resetBaseline = () => {
    const pane = panes[primaryIndex()];
    baseline = {
      top: pane.progress(),
      left: pane.scroller.scrollLeft / pane.viewer.currentScale,
    };
  };
  const cancelFrame = () => {
    if (frame) win.cancelAnimationFrame(frame);
    frame = 0;
  };
  const pauseForLayout = () => {
    cancelFrame();
    paused = true;
    win.clearTimeout(pauseTimer);
    pauseTimer = win.setTimeout(() => {
      if (disposed) return;
      const source = panes[primaryIndex()];
      alignFollower(source.progress() + alignmentOffset);
      resetBaseline();
      paused = false;
    }, 200);
  };
  const setPrimary = (side: Side) => {
    cancelFrame();
    primary = side;
    synchronizedFollowerTop = undefined;
    container.setAttribute("data-hjfy-primary-side", side);
    for (const [index, pane] of panes.entries()) {
      const isPrimary = index === primaryIndex();
      pane.browser.setAttribute(
        "data-hjfy-role",
        isPrimary ? "primary" : "follower",
      );
      pane.browser.setAttribute(
        "title",
        `${index === 0 ? "原文" : "译文"} · ${isPrimary ? "主窗口" : "从窗口"}（右键可切换主窗口）`,
      );
      pane.scroller.style.scrollbarColor = `${isPrimary ? "#3578e5" : "#999999"} transparent`;
      pane.browser.style.outline = isPrimary ? "2px solid #3578e5" : "none";
      pane.browser.style.outlineOffset = "-2px";
    }
    resetBaseline();
    rememberAlignment();
  };
  const removers: (() => void)[] = [];
  for (const [index, pane] of panes.entries()) {
    const onScroll = () => {
      if (disposed) return;
      if (index !== primaryIndex()) {
        if (!paused && pane.scroller.scrollTop !== synchronizedFollowerTop)
          rememberAlignment();
        return;
      }
      if (
        paused ||
        ctrlPressed ||
        win.Zotero_Tabs.selectedID !== container.id
      ) {
        resetBaseline();
        if (!paused) rememberAlignment();
        return;
      }
      if (frame) return;
      frame = win.requestAnimationFrame(() => {
        frame = 0;
        if (disposed) return;
        const source = panes[primaryIndex()];
        const target = panes[1 - primaryIndex()];
        const dx =
          source.scroller.scrollLeft / source.viewer.currentScale -
          baseline.left;
        const dy = source.progress() - baseline.top;
        resetBaseline();
        if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.00001) {
          alignFollower(
            source.progress() + alignmentOffset,
            Math.max(
              0,
              target.scroller.scrollLeft + dx * target.viewer.currentScale,
            ),
          );
        }
      });
    };
    pane.scroller.addEventListener("scroll", onScroll, { passive: true });
    pane.viewer.eventBus.on("scalechanging", pauseForLayout);
    // Zoom and sidebar animations must not be mistaken for page movement.
    const toolbarAction = (event: Event) => {
      const target = event.target as Element;
      const button = target.closest?.("button");
      if (!button) return;
      const zoom = ["zoomIn", "zoomOut", "zoomAuto"].find((name) =>
        button.classList.contains(name),
      );
      if (zoom || button.classList.contains("sidebar-toggle")) pauseForLayout();
      if (zoom && index === primaryIndex() && !ctrlPressed) {
        panes[1 - index].reader[zoom === "zoomAuto" ? "zoomReset" : zoom]();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const wasCtrlPressed = ctrlPressed;
      ctrlPressed = event.ctrlKey || event.metaKey;
      if (wasCtrlPressed && !ctrlPressed) resetBaseline();
      if (
        event.type === "keydown" &&
        ctrlPressed &&
        ["+", "=", "-", "0"].includes(event.key)
      ) {
        pauseForLayout();
        if (index === primaryIndex()) {
          const action =
            event.key === "-"
              ? "zoomOut"
              : event.key === "0"
                ? "zoomReset"
                : "zoomIn";
          panes[1 - index].reader[action]();
        }
      }
    };
    const onWheel = (event: WheelEvent) => {
      ctrlPressed = event.ctrlKey || event.metaKey;
      if (ctrlPressed) pauseForLayout();
    };
    const browserWindow = pane.browser.contentWindow!;
    const onBlur = () => {
      ctrlPressed = false;
      resetBaseline();
    };
    browserWindow.addEventListener("click", toolbarAction, true);
    // Listen in both reader toolbar and inner PDF frame for keyboard/wheel zoom.
    for (const target of [browserWindow, pane.pdfWindow]) {
      target.addEventListener("keydown", onKey, true);
      target.addEventListener("keyup", onKey, true);
      target.addEventListener("wheel", onWheel, {
        capture: true,
        passive: true,
      });
      target.addEventListener("blur", onBlur);
      removers.push(() => {
        target.removeEventListener("keydown", onKey, true);
        target.removeEventListener("keyup", onKey, true);
        target.removeEventListener("wheel", onWheel, true);
        target.removeEventListener("blur", onBlur);
      });
    }
    removers.push(() => {
      pane.scroller.removeEventListener("scroll", onScroll);
      pane.viewer.eventBus.off("scalechanging", pauseForLayout);
      browserWindow.removeEventListener("click", toolbarAction, true);
    });
  }
  const resizeObserver = new win.ResizeObserver(pauseForLayout);
  for (const pane of panes) resizeObserver.observe(pane.scroller);
  setPrimary("right");

  return {
    menuItems(side: Side) {
      return [
        {
          label: "设为主窗口（另一侧跟随翻页）",
          checked: primary === side,
          onCommand: () => setPrimary(side),
        },
      ];
    },
    destroy() {
      disposed = true;
      cancelFrame();
      win.clearTimeout(pauseTimer);
      resizeObserver.disconnect();
      for (const remove of removers) remove();
    },
  };
}
