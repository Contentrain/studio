/**
 * Sizing maths for the resizable project panels.
 *
 * Radix's `SplitterPanel` only understands percentages (1–100), but the widths
 * that matter to a reader are pixels: a content panel under ~280px can't show
 * an entry row, and a chat column under ~480px wraps code samples to shreds.
 * The shell is only capped above 1920px, so the percentage that corresponds to
 * a given pixel width changes with the viewport — these helpers do that
 * conversion against the measured group width, and the page feeds the result
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
 * Content-panel constraints for a given splitter group width.
 *
 * On a narrow desktop the pixel ceiling would leave the chat column unusable,
 * so the ceiling yields to `CHAT_MIN_PX` — but never below the floor, or the
 * panel would have an empty range and Radix would clamp it to nothing.
 */
export function contentPanelBounds(groupWidth: number): PanelBounds {
  const maxPx = Math.max(CONTENT_MIN_PX, Math.min(CONTENT_MAX_PX, groupWidth - CHAT_MIN_PX))
  const minSize = pxToPercent(CONTENT_MIN_PX, groupWidth)
  const maxSize = Math.max(minSize, pxToPercent(maxPx, groupWidth))

  return {
    minSize,
    maxSize,
    defaultSize: Math.min(maxSize, Math.max(minSize, pxToPercent(CONTENT_DEFAULT_PX, groupWidth))),
  }
}
