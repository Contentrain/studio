import { describe, expect, it } from 'vitest'
import {
  MAIN_MIN_PX,
  SIDEBAR_DEFAULT_PX,
  SIDEBAR_MAX_PX,
  SIDEBAR_MIN_PX,
  pxToPercent,
  sidebarPanelBounds,
} from '../../app/utils/panel-sizing'

/** Radix works in percent; the constraints are written in pixels. */
function toPx(percent: number, groupWidth: number) {
  return Math.round((percent / 100) * groupWidth)
}

describe('sidebarPanelBounds', () => {
  it('keeps the current 240px sidebar as the default so nothing jumps', () => {
    const groupWidth = 1600
    const bounds = sidebarPanelBounds(groupWidth)

    expect(toPx(bounds.defaultSize, groupWidth)).toBe(SIDEBAR_DEFAULT_PX)
  })

  it('holds the 180–360px range on a roomy shell', () => {
    const groupWidth = 1920
    const bounds = sidebarPanelBounds(groupWidth)

    expect(toPx(bounds.minSize, groupWidth)).toBe(SIDEBAR_MIN_PX)
    expect(toPx(bounds.maxSize, groupWidth)).toBe(SIDEBAR_MAX_PX)
  })

  it('yields the ceiling to the rest of the page when the shell is narrow', () => {
    // At the `md` breakpoint the full 360px would leave 408px for the work.
    const groupWidth = 768
    const bounds = sidebarPanelBounds(groupWidth)

    expect(toPx(bounds.maxSize, groupWidth)).toBe(groupWidth - MAIN_MIN_PX)
    expect(toPx(bounds.maxSize, groupWidth)).toBeLessThan(SIDEBAR_MAX_PX)
  })

  it('never returns an empty range, however little room there is', () => {
    // An inverted range makes Radix clamp the panel to nothing — and it saves
    // the result, so the sidebar would come back collapsed forever after.
    for (const groupWidth of [320, 480, 600, 660]) {
      const bounds = sidebarPanelBounds(groupWidth)
      expect(bounds.maxSize).toBeGreaterThanOrEqual(bounds.minSize)
      expect(bounds.defaultSize).toBeGreaterThanOrEqual(bounds.minSize)
      expect(bounds.defaultSize).toBeLessThanOrEqual(bounds.maxSize)
    }
  })

  it('survives an unmeasured group without producing NaN', () => {
    // The observer reports 0 during teardown; percentages must stay numbers.
    const bounds = sidebarPanelBounds(0)

    expect(bounds.minSize).toBe(0)
    expect(bounds.maxSize).toBe(0)
    expect(bounds.defaultSize).toBe(0)
    expect(pxToPercent(SIDEBAR_MIN_PX, 0)).toBe(0)
  })

  it('leaves the chat column usable at the widest the shell ever gets', () => {
    // The shell caps at 1920px; sidebar at its widest plus the content panel at
    // its widest must not squeeze the chat column below its own floor.
    const CONTENT_MAX_PX = 640
    const CHAT_MIN_PX = 480
    const remaining = 1920 - SIDEBAR_MAX_PX - CONTENT_MAX_PX

    expect(remaining).toBeGreaterThanOrEqual(CHAT_MIN_PX)
  })
})
