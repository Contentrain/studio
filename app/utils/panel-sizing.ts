/**
 * Sizing maths for the resizable panels — the shell's sidebar, and the project
 * page's chat/content split.
 *
 * Radix's `SplitterPanel` only understands percentages (1–100), but the widths
 * that matter to a reader are pixels: a content panel under ~280px can't show
 * an entry row, and a chat column under ~480px wraps code samples to shreds.
 * The shell is only capped above 1920px, so the percentage that corresponds to
 * a given pixel width changes with the viewport — these helpers do that
 * conversion against the measured group width, and each page feeds the result
 * back as reactive constraints.
 */

/** Below this the content panel can't render an entry row usefully. */
export const CONTENT_MIN_PX = 280
/** Past this the panel is just whitespace; the chat column is the better home. */
export const CONTENT_MAX_PX = 640
/** Matches the previous fixed `xl:w-96`, so nothing jumps on first load. */
export const CONTENT_DEFAULT_PX = 384
/** Floor reserved for the chat column — the content panel's max yields to it. */
export const CHAT_MIN_PX = 480

/** Under this the workspace switcher and project names stop being readable. */
export const SIDEBAR_MIN_PX = 180
/** Past this the sidebar is taking width from the work, not giving it. */
export const SIDEBAR_MAX_PX = 360
/** Matches the previous fixed `w-60`, so nothing jumps on first load. */
export const SIDEBAR_DEFAULT_PX = 240
/** Floor reserved for everything right of the sidebar. */
export const MAIN_MIN_PX = 480

export interface PanelBounds {
  minSize: number
  maxSize: number
  defaultSize: number
}

/** Express a pixel width as a percentage of the splitter group. */
export function pxToPercent(px: number, groupWidth: number): number {
  if (!Number.isFinite(groupWidth) || groupWidth <= 0) return 0
  return Math.min(100, Math.max(0, (px / groupWidth) * 100))
}

/**
 * Convert a panel's pixel intent into the percentages Radix wants.
 *
 * On a narrow desktop the pixel ceiling would leave its neighbour unusable, so
 * the ceiling yields to `reservePx` — but never below the floor, or the panel
 * would have an empty range and Radix would clamp it to nothing.
 */
function panelBounds(
  groupWidth: number,
  { minPx, maxPx, defaultPx, reservePx }: { minPx: number, maxPx: number, defaultPx: number, reservePx: number },
): PanelBounds {
  const ceilingPx = Math.max(minPx, Math.min(maxPx, groupWidth - reservePx))
  const minSize = pxToPercent(minPx, groupWidth)
  const maxSize = Math.max(minSize, pxToPercent(ceilingPx, groupWidth))

  return {
    minSize,
    maxSize,
    defaultSize: Math.min(maxSize, Math.max(minSize, pxToPercent(defaultPx, groupWidth))),
  }
}

/** Content-panel constraints for a given splitter group width. */
export function contentPanelBounds(groupWidth: number): PanelBounds {
  return panelBounds(groupWidth, {
    minPx: CONTENT_MIN_PX,
    maxPx: CONTENT_MAX_PX,
    defaultPx: CONTENT_DEFAULT_PX,
    reservePx: CHAT_MIN_PX,
  })
}

/**
 * Sidebar constraints for a given shell width.
 *
 * The shell group spans the whole window (up to the 1920px cap), so this is the
 * one that decides how much is left for the page — including the project page's
 * own splitter, which measures what it actually gets rather than assuming.
 */
export function sidebarPanelBounds(groupWidth: number): PanelBounds {
  return panelBounds(groupWidth, {
    minPx: SIDEBAR_MIN_PX,
    maxPx: SIDEBAR_MAX_PX,
    defaultPx: SIDEBAR_DEFAULT_PX,
    reservePx: MAIN_MIN_PX,
  })
}
