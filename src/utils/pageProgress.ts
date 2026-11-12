export interface PageBounds {
  top: number;
  height: number;
}

/** Express a vertical position in pages, including the gap after each page. */
export function getPageProgress(top: number, pages: PageBounds[]): number {
  let index = 0;
  while (index + 1 < pages.length && pages[index + 1].top <= top) index++;
  const page = pages[index];
  const span = pages[index + 1] ? pages[index + 1].top - page.top : page.height;
  return index + (top - page.top) / Math.max(1, span);
}

export function getPageScrollTop(
  progress: number,
  pages: PageBounds[],
): number {
  const index = Math.max(0, Math.min(pages.length - 1, Math.floor(progress)));
  const page = pages[index];
  const span = pages[index + 1] ? pages[index + 1].top - page.top : page.height;
  return Math.max(0, page.top + (progress - index) * Math.max(1, span));
}
