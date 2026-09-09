import { describe, expect, it } from 'vitest'
import { judgePreflight } from '../../scripts/wp-runtime-preflight.mjs'

describe('read-only generated-site preflight verdict', () => {
  it('never equates successful smoke checks with full acceptance', () => {
    expect(judgePreflight([{ route: '/', width: 1280 }])).toMatchObject({ status: 'preflight_passed', fullAcceptance: false })
  })
  it('does not pass an empty run', () => {
    expect(judgePreflight([]).failures).toContain('no_pages_checked')
  })
  it('keeps unbound runtime capabilities open', () => {
    expect(judgePreflight([{ route: '/', width: 390 }], ['comments'])).toMatchObject({ status: 'blocked', runtimePending: ['comments'] })
  })
  it.each(['httpError', 'missingHeading', 'emptyComponents', 'brokenImages', 'navigationError'])('%s blocks acceptance', (key) => {
    expect(judgePreflight([{ route: '/article/', width: 390, [key]: 1 }]).status).toBe('blocked')
  })
  it.each(['externalRequests', 'failedAssets', 'pageErrors'])('%s blocks acceptance', (key) => {
    expect(judgePreflight([{ route: '/article/', width: 1280, [key]: ['failure'] }]).status).toBe('blocked')
  })
})
