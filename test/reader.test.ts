import { assert } from "chai";
import { ArxivTranslationFactory } from "../src/modules/arxivTranslation";
import { DesktopTranslation } from "../src/modules/desktopTranslation";
import { closeTranslationReaders } from "../src/modules/translationReader";

describe("existing translation in a single split tab", function () {
  this.timeout(90000);

  it("loads one split tab with primary/follower navigation and reopens without logs", async function () {
    const pdf = Services.env.get("HJFY_TEST_PDF");
    if (!pdf) return this.skip();
    const item = new Zotero.Item("preprint");
    item.setField("title", "Reader integration");
    item.setField("url", "https://arxiv.org/abs/2610.34593v1");
    await item.saveTx();
    const originalTranslate = DesktopTranslation.translate;
    DesktopTranslation.translate = async () => {
      throw new Error("An existing translation must not invoke the engine");
    };
    const win = Zotero.getMainWindow();
    const tabs = win.Zotero_Tabs as any;
    try {
      const original = await Zotero.Attachments.importFromFile({
        file: pdf,
        parentItemID: item.id,
      });
      const translated = await ArxivTranslationFactory.savePdfAsAttachment(
        item,
        pdf,
        "2610.34593v1",
      );
      const before = tabs._tabs.length;
      let tabID: string | undefined;
      let translatedReader: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        const found = await ArxivTranslationFactory.translateSingleItem(item);
        assert.equal(found.id, translated.id);
        assert.equal(tabs._tabs.length, before + 1);
        if (tabID) assert.equal(tabs.selectedID, tabID);
        tabID = tabs.selectedID;
        const container = win.document.getElementById(tabID!)!;
        assert.isTrue(container.classList.contains("hjfy-split-readers"));
        const browsers = container.querySelectorAll("browser.reader");
        assert.lengthOf(browsers, 2);
        const left = (browsers[0] as any).contentWindow.wrappedJSObject._reader;
        translatedReader = (browsers[1] as any).contentWindow.wrappedJSObject
          ._reader;
        await left._primaryView.initializedPromise;
        await translatedReader._primaryView.initializedPromise;
        assert.isAbove(
          left._primaryView._iframeWindow.PDFViewerApplication.pdfDocument
            .numPages,
          0,
        );
        assert.isAbove(
          translatedReader._primaryView._iframeWindow.PDFViewerApplication
            .pdfDocument.numPages,
          0,
        );
        const rects = Array.from(browsers, (browser) =>
          (browser as Element).getBoundingClientRect(),
        );
        assert.isAbove(rects[0].width, 200);
        assert.isAbove(rects[1].width, 200);
        assert.isAtLeast(rects[1].left, rects[0].right);
        assert.closeTo(rects[0].top, rects[1].top, 2);
        assert.lengthOf(
          (Zotero.Reader as any)._readers.filter(
            (reader: any) =>
              [original.id, translated.id].includes(reader.itemID) &&
              !reader.tabID,
          ),
          0,
        );
        assert.lengthOf(item.getNotes(), 0);
      }
      const container = win.document.getElementById(tabID!)!;
      const browsers = container.querySelectorAll("browser.reader");
      const leftReader = (browsers[0] as any).contentWindow.wrappedJSObject
        ._reader;
      const leftPDF = leftReader._primaryView._iframeWindow;
      const rightPDF = translatedReader._primaryView._iframeWindow;
      const leftScroller = leftPDF.document.getElementById("viewerContainer");
      const rightScroller = rightPDF.document.getElementById("viewerContainer");
      const waitUntil = async (check: () => boolean, message: string) => {
        for (let i = 0; i < 100; i++) {
          if (check()) return;
          await Zotero.Promise.delay(50);
        }
        assert.fail(
          `${message}: ${JSON.stringify({
            left: leftScroller.scrollTop,
            right: rightScroller.scrollTop,
            leftHeight: leftScroller.scrollHeight,
            rightHeight: rightScroller.scrollHeight,
            leftViewport: leftScroller.clientHeight,
            rightViewport: rightScroller.clientHeight,
          })}`,
        );
      };
      // Allow initial PDF and pane layout events to settle before scrolling.
      await Zotero.Promise.delay(500);
      assert.equal(container.getAttribute("data-hjfy-primary-side"), "right");
      assert.equal(browsers[0].getAttribute("data-hjfy-role"), "follower");
      assert.equal(browsers[1].getAttribute("data-hjfy-role"), "primary");
      const defaultLeft = leftScroller.scrollTop;
      rightScroller.scrollBy(0, 180);
      await waitUntil(
        () => leftScroller.scrollTop > defaultLeft + 150,
        "Translation must control the original by default",
      );
      // Switch to the original through its actual native context menu.
      const originalReader = Zotero.Reader.getByTabID(tabID!) as any;
      void originalReader._openContextMenu({ x: 10, y: 10, itemGroups: [] });
      await Zotero.Promise.delay(100);
      const initialMenu = container.querySelector(
        'menuitem[label="设为主窗口（另一侧跟随翻页）"]',
      )!;
      (initialMenu as XULMenuItemElement).doCommand();
      await waitUntil(
        () => container.getAttribute("data-hjfy-primary-side") === "left",
        "Original can become primary",
      );
      (initialMenu.parentElement as any).hidePopup();
      const leftStart = leftScroller.scrollTop;
      const rightStart = rightScroller.scrollTop;
      leftScroller.scrollBy(0, 180);
      await waitUntil(
        () => rightScroller.scrollTop > rightStart + 150,
        "Translation must follow original scrolling",
      );
      assert.closeTo(
        rightScroller.scrollTop - rightStart,
        leftScroller.scrollTop - leftStart,
        3,
      );
      // A follower can be positioned independently without moving the primary.
      const primaryPosition = leftScroller.scrollTop;
      rightScroller.scrollBy(0, 240);
      await Zotero.Promise.delay(200);
      assert.closeTo(leftScroller.scrollTop, primaryPosition, 1);
      const offset = rightScroller.scrollTop - leftScroller.scrollTop;
      leftReader.navigateToNextPage();
      await waitUntil(
        () => leftScroller.scrollTop > primaryPosition + 300,
        "Page navigation must move the original",
      );
      await waitUntil(
        () =>
          Math.abs(rightScroller.scrollTop - leftScroller.scrollTop - offset) <
          4,
        "Next-page navigation must preserve manually aligned offset",
      );
      const nextPosition = leftScroller.scrollTop;
      leftReader.navigateToPreviousPage();
      await waitUntil(
        () => leftScroller.scrollTop < nextPosition - 300,
        "Previous-page navigation must move back",
      );
      await waitUntil(
        () =>
          Math.abs(rightScroller.scrollTop - leftScroller.scrollTop - offset) <
          4,
        "Previous-page navigation must also propagate",
      );
      // Exercise the actual right-pane context menu, rather than a test-only setter.
      translatedReader._onOpenContextMenu(
        Components.utils.cloneInto(
          {
            x: 10,
            y: 10,
            itemGroups: [],
          },
          (browsers[1] as any).contentWindow,
        ),
      );
      const primaryMenu = container.querySelector(
        'menuitem[label="设为主窗口（另一侧跟随翻页）"]',
      )!;
      assert.isOk(primaryMenu);
      (primaryMenu as XULMenuItemElement).doCommand();
      await waitUntil(
        () => container.getAttribute("data-hjfy-primary-side") === "right",
        `Right primary command must run: ${primaryMenu.outerHTML}`,
      );
      (primaryMenu.parentElement as any).hidePopup();
      assert.equal(container.getAttribute("data-hjfy-primary-side"), "right");
      const newLeftStart = leftScroller.scrollTop;
      rightScroller.scrollBy(0, 180);
      await waitUntil(
        () => leftScroller.scrollTop > newLeftStart + 150,
        "Original must follow when translation is primary",
      );
      const newRightStart = rightScroller.scrollTop;
      leftScroller.scrollBy(0, 120);
      await Zotero.Promise.delay(200);
      assert.closeTo(rightScroller.scrollTop, newRightStart, 1);
      // The original reader's native menu must expose the same primary command.
      const nativeReader = Zotero.Reader.getByTabID(tabID!) as any;
      void nativeReader._openContextMenu({ x: 10, y: 10, itemGroups: [] });
      await Zotero.Promise.delay(100);
      const leftMenu = container.querySelector(
        'menuitem[label="设为主窗口（另一侧跟随翻页）"]',
      )!;
      assert.isOk(leftMenu);
      (leftMenu as XULMenuItemElement).doCommand();
      await waitUntil(
        () => container.getAttribute("data-hjfy-primary-side") === "left",
        "Left primary command must run",
      );
      (leftMenu.parentElement as any).hidePopup();
      assert.equal(container.getAttribute("data-hjfy-primary-side"), "left");
      const leftViewer = leftPDF.PDFViewerApplication.pdfViewer;
      const rightViewer = rightPDF.PDFViewerApplication.pdfViewer;
      const leftScale = leftViewer.currentScale;
      const rightScale = rightViewer.currentScale;
      // Click the actual toolbar control to exercise scale and layout guards.
      const zoomButton = (browsers[0] as any).contentDocument.querySelector(
        "button.zoomIn",
      );
      assert.isOk(zoomButton);
      zoomButton.click();
      await waitUntil(
        () =>
          leftViewer.currentScale > leftScale &&
          rightViewer.currentScale > rightScale,
        "Primary toolbar zoom must also zoom the follower",
      );
      await Zotero.Promise.delay(400);
      const afterZoom = rightScroller.scrollTop;
      leftScroller.scrollBy(0, 120);
      await waitUntil(
        () => rightScroller.scrollTop > afterZoom + 100,
        "Scrolling must keep following after zoom settles",
      );
      // This fixture has equal-sized pages. Measure page units independently
      // from the sync helper to catch equal-pixel drift at unequal zoom levels.
      const position = (scroller: any, viewer: any) => {
        const first = viewer.getPageView(0).div.getBoundingClientRect();
        const second = viewer.getPageView(1).div.getBoundingClientRect();
        const firstTop =
          first.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        return (scroller.scrollTop - firstTop) / (second.top - first.top);
      };
      const alignedOffset =
        position(rightScroller, rightViewer) -
        position(leftScroller, leftViewer);
      leftViewer.currentScale = 1.1;
      rightViewer.currentScale = 0.65;
      await Zotero.Promise.delay(700);
      assert.closeTo(
        position(rightScroller, rightViewer) -
          position(leftScroller, leftViewer),
        alignedOffset,
        0.015,
        "Changing zoom must preserve page-relative manual alignment",
      );
      for (let step = 0; step < 4; step++) {
        const previous = rightScroller.scrollTop;
        leftScroller.scrollBy(0, 260);
        await waitUntil(
          () => rightScroller.scrollTop > previous + 30,
          "Follower must continue moving at a different zoom",
        );
        assert.closeTo(
          position(rightScroller, rightViewer) -
            position(leftScroller, leftViewer),
          alignedOffset,
          0.015,
          "Repeated scrolling at unequal zoom must not accumulate progress drift",
        );
      }
      // Small increments expose rounding drift that a few large scrolls hide.
      for (let step = 0; step < 30; step++) {
        const previous = rightScroller.scrollTop;
        leftScroller.scrollBy(0, 13);
        await waitUntil(
          () => rightScroller.scrollTop > previous,
          "Small primary scrolls must reach the follower",
        );
      }
      assert.closeTo(
        position(rightScroller, rightViewer) -
          position(leftScroller, leftViewer),
        alignedOffset,
        0.002,
        "Small scroll increments must not accumulate pixel rounding drift",
      );
      translatedReader._onOpenContextMenu(
        Components.utils.cloneInto(
          { x: 10, y: 10, itemGroups: [] },
          (browsers[1] as any).contentWindow,
        ),
      );
      const scaledMenu = container.querySelector(
        'menuitem[label="设为主窗口（另一侧跟随翻页）"]',
      )!;
      (scaledMenu as XULMenuItemElement).doCommand();
      await waitUntil(
        () => container.getAttribute("data-hjfy-primary-side") === "right",
        "Translation can become primary at unequal zoom",
      );
      (scaledMenu.parentElement as any).hidePopup();
      for (const amount of [140, -55]) {
        const previous = leftScroller.scrollTop;
        rightScroller.scrollBy(0, amount);
        await waitUntil(
          () => (leftScroller.scrollTop - previous) * Math.sign(amount) > 50,
          "Original must follow the zoomed translation in both directions",
        );
        assert.closeTo(
          position(rightScroller, rightViewer) -
            position(leftScroller, leftViewer),
          alignedOffset,
          0.002,
          "Switching primary must preserve alignment across unequal zoom",
        );
      }
      assert.lengthOf(item.getNotes(), 0);
      // Saving in the right pane must link annotations to the translation.
      const annotationID = (Zotero as any).DataObjectUtilities.generateKey();
      await translatedReader._onSaveAnnotations(
        [
          {
            id: annotationID,
            type: "highlight",
            color: "#ffd400",
            text: "Translation test",
            comment: "",
            pageLabel: "1",
            sortIndex: "00000|000000|00000",
            position: { pageIndex: 0, rects: [[20, 20, 100, 40]] },
            tags: [],
          },
        ],
        () => {},
      );
      const annotation = Zotero.Items.getByLibraryAndKey(
        translated.libraryID,
        annotationID,
      );
      assert.isOk(annotation);
      assert.equal((annotation as Zotero.Item).parentID, translated.id);
      // Existing logs remain byte-for-byte unchanged when opening again.
      const note = new Zotero.Item("note");
      note.parentID = item.id;
      note.setNote("<p>Completed log</p>");
      await note.saveTx();
      const saved = note.getNote();
      tabs.close(tabID);
      await ArxivTranslationFactory.translateSingleItem(item);
      assert.equal(
        win.document
          .getElementById(tabs.selectedID)!
          .getAttribute("data-hjfy-primary-side"),
        "right",
      );
      assert.notEqual(tabs.selectedID, tabID);
      assert.equal(tabs._tabs.length, before + 1);
      assert.lengthOf(item.getAttachments(), 2);
      assert.deepEqual(item.getNotes(), [note.id]);
      assert.equal(note.getNote(), saved);
      closeTranslationReaders();
      assert.equal(tabs._tabs.length, before);
    } catch (error) {
      await IOUtils.writeJSON(
        PathUtils.join(PathUtils.profileDir, "hjfy-reader-error.json"),
        {
          error: String(error),
          stack: (error as Error).stack,
        },
      );
      throw new Error(String(error));
    } finally {
      DesktopTranslation.translate = originalTranslate;
      closeTranslationReaders();
      await Zotero.Items.erase(item.id);
    }
  });
});
