import { describe, expect, it } from 'vitest'
import {
  COMMENTS_CONFIG_DEFAULTS,
  countCommentEnabledModels,
  getCommentsConfig,
  modelSupportsComments,
  normalizeCommentsConfig,
} from '../../server/utils/comment-types'
import { decodeHtmlEntities, htmlToPlainText, sanitizeString } from '../../server/utils/sanitize-input'

describe('normalizeCommentsConfig', () => {
  it('fills defaults for an empty block', () => {
    expect(normalizeCommentsConfig({})).toEqual(COMMENTS_CONFIG_DEFAULTS)
  })

  it('clamps numeric settings to the hard ceilings and floors', () => {
    const cfg = normalizeCommentsConfig({ enabled: true, maxDepth: 99, rateLimitPerIp: 0, maxBodyLength: 1 })
    expect(cfg.maxDepth).toBe(10)
    expect(cfg.rateLimitPerIp).toBe(1)
    expect(cfg.maxBodyLength).toBe(100)
  })

  it('only accepts turnstile as a captcha value', () => {
    expect(normalizeCommentsConfig({ captcha: 'turnstile' }).captcha).toBe('turnstile')
    expect(normalizeCommentsConfig({ captcha: 'recaptcha' as unknown as 'turnstile' }).captcha).toBeNull()
  })

  it('treats non-numeric values as defaults', () => {
    expect(normalizeCommentsConfig({ maxDepth: 'deep' as unknown as number }).maxDepth).toBe(4)
  })
})

describe('getCommentsConfig / countCommentEnabledModels / modelSupportsComments', () => {
  it('reads and normalizes the comments block off a model', () => {
    expect(getCommentsConfig({ comments: { enabled: true } })?.enabled).toBe(true)
    expect(getCommentsConfig({ comments: { enabled: true } })?.requireApproval).toBe(true)
    expect(getCommentsConfig({})).toBeUndefined()
    expect(getCommentsConfig(null)).toBeUndefined()
  })

  it('counts enabled models only', () => {
    const models = new Map<string, unknown>([
      ['a', { comments: { enabled: true } }],
      ['b', { comments: { enabled: false } }],
      ['c', {}],
    ])
    expect(countCommentEnabledModels(models)).toBe(1)
  })

  it('allows collections and documents, not singletons or dictionaries', () => {
    expect(modelSupportsComments({ kind: 'collection' })).toBe(true)
    expect(modelSupportsComments({ type: 'document' })).toBe(true)
    expect(modelSupportsComments({ kind: 'singleton' })).toBe(false)
    expect(modelSupportsComments({ kind: 'dictionary' })).toBe(false)
  })
})

describe('sanitize-input', () => {
  it('strips tags, entity-hidden tags and inline handlers', () => {
    expect(sanitizeString('<b>hi</b>')).toBe('hi')
    expect(sanitizeString('&lt;script&gt;x&lt;/script&gt;')).toBe('x')
    expect(sanitizeString('a onclick=1 javascript:b')).toBe('a 1 b')
  })

  it('turns comment HTML into readable plain text', () => {
    expect(htmlToPlainText('<p>One &amp; two</p><p>Three<br>four</p>')).toBe('One & two\nThree\nfour')
    expect(htmlToPlainText('<img src=x onerror=alert(1)>')).toBe('')
  })
})

describe('sanitize-input — character references', () => {
  it('decodes the numeric and named references WordPress emits', () => {
    expect(decodeHtmlEntities('I&#8217;m here &amp; there&hellip; &#x2019;quoted&rsquo; 5&nbsp;km')).toBe('I’m here & there… ’quoted’ 5 km')
    expect(decodeHtmlEntities('&unknown; &#0; &#xD800; &#1114112;')).toBe('&unknown; &#0; &#xD800; &#1114112;')
  })

  it('imported bodies read as text: entities decoded, nbsp normalised, entity-encoded tags still stripped', () => {
    expect(htmlToPlainText('<p>I&#8217;m &ldquo;here&rdquo;&nbsp;&mdash; you?</p>')).toBe('I’m “here” — you?')
    expect(htmlToPlainText('&lt;script&gt;alert(1)&lt;/script&gt;stay')).toBe('alert(1)stay')
    expect(htmlToPlainText('<p>a &lt; b &amp;&amp; c &gt; d</p>')).toBe('a  d')
  })
})
