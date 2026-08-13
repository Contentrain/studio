import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_PX,
  CONTENT_MAX_PX,
  CONTENT_MIN_PX,
  contentPanelBounds,
  pxToPercent,
} from '../../app/utils/panel-sizing'

/** Splitter group width = min(viewport, 1920) − 240px sidebar. */
const GROUP_AT_1280 = 1040
const GROUP_AT_1440 = 1200
const GROUP_AT_1920 = 1680

describe('pxToPercent', () => {
  it('converts against the measured group width', () => {
    expect(pxToPercent(384, GROUP_AT_1920)).toBeCloseTo(22.86, 1)
    expect(pxToPercent(384, GROUP_AT_1280)).toBeCloseTo(36.92, 1)
  })

  it('survives a group that has not been measured yet', () => {
    // The first render can run before ResizeObserver reports, and a division
    // by zero here would reach Radix as NaN and blank the panel.
    expect(pxToPercent(384, 0)).toBe(0)
    expect(pxToPercent(384, -10)).toBe(0)
    expect(pxToPercent(384, Number.NaN)).toBe(0)
  })

  it('never reports more than the whole group', () => {
    expect(pxToPercent(4000, GROUP_AT_1280)).toBe(100)
  })
})

describe('contentPanelBounds', () => {
  it('keeps the pixel floor and ceiling on a wide shell', () => {
    const { minSize, maxSize } = contentPanelBounds(GROUP_AT_1920)

    expect((minSize / 100) * GROUP_AT_1920).toBeCloseTo(CONTENT_MIN_PX, 0)
    expect((maxSize / 100) * GROUP_AT_1920).toBeCloseTo(CONTENT_MAX_PX, 0)
  })

  it('yields the ceiling to the chat column on a narrow desktop', () => {
    // 1040 − 480 = 560px, below the 640px ceiling.
    const { maxSize } = contentPanelBounds(GROUP_AT_1280)
    const maxPx = (maxSize / 100) * GROUP_AT_1280

    expect(maxPx).toBeCloseTo(GROUP_AT_1280 - CHAT_MIN_PX, 0)
    expect(maxPx).toBeLessThan(CONTENT_MAX_PX)
  })

  it('leaves the chat column at least its floor at every width', () => {
    for (const group of [800, GROUP_AT_1280, GROUP_AT_1440, GROUP_AT_1920]) {
      const { maxSize } = contentPanelBounds(group)
      const chatPx = group - (maxSize / 100) * group

      // The floor gives way only when the group is too narrow to honour both;
      // there the content minimum wins so the panel keeps a usable range.
      expect(chatPx).toBeGreaterThanOrEqual(Math.min(CHAT_MIN_PX, group - CONTENT_MIN_PX) - 0.5)
    }
  })

  it('holds min <= default <= max <= 100 across viewports', () => {
    for (const group of [400, 700, GROUP_AT_1280, GROUP_AT_1440, GROUP_AT_1920, 2400]) {
      const { minSize, maxSize, defaultSize } = contentPanelBounds(group)

      expect(minSize).toBeLessThanOrEqual(maxSize)
      expect(defaultSize).toBeGreaterThanOrEqual(minSize)
      expect(defaultSize).toBeLessThanOrEqual(maxSize)
      expect(maxSize).toBeLessThanOrEqual(100)
    }
  })

  it('opens at the old fixed width when there is room for it', () => {
    const { defaultSize } = contentPanelBounds(GROUP_AT_1920)

    expect((defaultSize / 100) * GROUP_AT_1920).toBeCloseTo(384, 0)
  })

  it('does not collapse the range when the group is narrower than both floors', () => {
    // 600 − 480 = 120px, under the content floor: the floor has to win.
    const { minSize, maxSize } = contentPanelBounds(600)

    expect(minSize).toBeGreaterThan(0)
    expect(maxSize).toBeGreaterThanOrEqual(minSize)
  })
})
