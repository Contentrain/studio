/**
 * SVG sanitizing — one rule set shared with Migrate (`packages/media/src/svg.ts`
 * in the migrate repo), applied again here because the repository an import
 * reads from is the customer's: a file in `public/media/` may not have come
 * through Migrate at all.
 *
 * An SVG is an executable document: opened directly from the media host it
 * runs on that origin. So nothing is kept unless it is known to be inert:
 *
 * - **Elements: an allow-list** ({@link ALLOWED_ELEMENTS}) — the drawing,
 *   paint-server, filter and animation vocabulary of SVG. Anything else is
 *   removed WITH its content: `script`, `foreignObject`, `iframe`, XHTML
 *   (`meta refresh` is an open redirect on the media host, `img` a beacon),
 *   editor metadata (`sodipodi:*`, `inkscape:*`, `metadata`). A namespace
 *   prefix is accepted only as `svg:`.
 * - **Attributes:** every `on*` is dropped; `href`/`xlink:href` keeps only a
 *   `#fragment`, `""` or a raster `data:image`; any value carrying
 *   `javascript:`/`vbscript:` is dropped; `set`/`animate*` that animate an
 *   `href` are removed.
 * - **CSS** (`style` attributes, `<style>`, and any attribute holding CSS
 *   functions): comments stripped and escapes decoded FIRST (`\75 rl(`,
 *   `\@import`, `ur/**\/l(`), then `@import`, `url()`/`image-set()` other than
 *   `#`/raster `data:`, `expression(`, `-moz-binding`/`behavior` are removed.
 * - DOCTYPE (entities: XXE, billion laughs) and processing instructions other
 *   than the leading xml declaration are removed.
 *
 * The walk is a tokenizer with a skip depth, not paired regexes. The result
 * must then pass a well-formedness check and an independent check
 * ({@link svgProblems}); if either finds anything, the SVG is refused.
 */

export const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'desc', 'title', 'symbol', 'use', 'image', 'switch', 'a', 'view', 'style',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath',
  'clipPath', 'mask', 'marker', 'pattern', 'linearGradient', 'radialGradient', 'stop',
  'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
  'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
  'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
  'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
  'animate', 'animateTransform', 'animateMotion', 'set', 'mpath',
])
const SMIL = new Set(['animate', 'animateTransform', 'animateMotion', 'set'])

/** Attribute parser: name, `=`, quoted or unquoted value. */
const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g
/** An opening or self-closing tag; a `>` inside quotes does not end it. */
const TAG = /<([a-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/gi
/** One token of the document, in order. */
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>|<\?[\s\S]*?\?>|<\/([a-z][\w:.-]*)\s*>|<([a-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|<|[^<]+/gi

const unquote = (value: string | undefined): string => (value ?? '').replace(/^(["'])([\s\S]*)\1$/, '$2')

/** The element's name as the allow-list knows it, or null for a prefix other than `svg:`. */
function localName(name: string): string | null {
  const colon = name.indexOf(':')
  if (colon === -1) return name
  return name.slice(0, colon).toLowerCase() === 'svg' ? name.slice(colon + 1) : null
}

const isAllowedElement = (name: string): boolean => {
  const local = localName(name)
  return local !== null && ALLOWED_ELEMENTS.has(local)
}

/** Resolve character references and drop whitespace/control characters — for allow-list comparison only. */
function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&colon;/gi, ':')
    .replace(/&tab;|&newline;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, '\'')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, '')
    // Control characters (a browser runs `java\x01script:` too) — filtered by code point, not in a regex.
    .split('')
    .filter(ch => ch.charCodeAt(0) > 0x1F && ch.charCodeAt(0) !== 0x7F)
    .join('')
}

function safeCodePoint(cp: number): string {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '\uFFFD'
}

/** CSS as the browser reads it: comments gone, `\HEX ` and `\X` escapes decoded. */
export function decodeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\([^\n\r\f0-9a-f])/gi, '$1')
}

const allowedRef = (raw: string): boolean => {
  const value = decode(raw)
  return value === '' || value.startsWith('#') || /^data:image\/(?:png|jpe?g|gif|webp|avif);/i.test(value)
}

const isHrefName = (name: string): boolean => /^(?:[\w-]+:)?href$/i.test(name)

/** Something CSS could load or run through. */
const CSS_ACTIVE = /url\(|image-set\(|@import|expression\s*\(|-moz-binding|behavior\s*:/i

function cleanCss(css: string, removed: Set<string>): string {
  let out = decodeCss(css)
  out = out.replace(/@import\b[^;]*;?/gi, () => {
    removed.add('@import')
    return ''
  })
  out = out.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (all, _q: string, target: string) => {
    if (allowedRef(target)) return all
    removed.add('url()')
    return 'none'
  })
  out = out.replace(/(?:-webkit-)?image-set\([^)]*\)/gi, () => {
    removed.add('image-set()')
    return 'none'
  })
  out = out.replace(/(?:-moz-binding|behavior)\s*:[^;}"']*;?/gi, () => {
    removed.add('binding')
    return ''
  })
  out = out.replace(/expression\s*\(/gi, () => {
    removed.add('expression')
    return '('
  })
  return out
}

function cleanAttributes(attrs: string, removed: Set<string>): string[] {
  const kept: string[] = []
  for (const match of attrs.matchAll(ATTR)) {
    const attr = match[1]!
    const raw = match[2]
    const value = unquote(raw)
    if (/^on/i.test(attr)) {
      removed.add('on*')
      continue
    }
    if (isHrefName(attr) && !allowedRef(value)) {
      removed.add('href')
      continue
    }
    if (/javascript:|vbscript:/i.test(decode(value))) {
      removed.add('javascript:')
      continue
    }
    if (attr.toLowerCase() === 'style' || CSS_ACTIVE.test(decodeCss(value))) {
      kept.push(`${attr}="${cleanCss(value, removed).replace(/"/g, '&quot;')}"`)
      continue
    }
    kept.push(raw === undefined ? attr : `${attr}=${raw}`)
  }
  return kept
}

/** `set`/`animate*` whose target is an `href` (`attributeName="xlink:href"`, entity-encoded too). */
function animatesHref(attrs: string): boolean {
  for (const match of attrs.matchAll(ATTR)) {
    if (match[1]!.toLowerCase() === 'attributename' && /^(?:[\w-]+:)?href$/i.test(decode(unquote(match[2])))) return true
  }
  return false
}

export type SvgSanitized = { ok: true, bytes: Buffer, removed: string[] } | { ok: false, reason: string }

export function sanitizeSvg(input: Buffer): SvgSanitized {
  const removed = new Set<string>()
  const text = input.toString('utf8').replace(/^\uFEFF/, '')
  const out: string[] = []
  let skip = 0
  let inStyle = 0
  let first = true

  for (const m of text.matchAll(TOKEN)) {
    const token = m[0]
    const closeName = m[1]
    const openName = m[2]
    const leading = first
    first = false

    if (token === '<') return { ok: false, reason: 'malformed: unparsed `<`' }

    if (skip > 0) {
      if (openName && !m[4]) skip++
      else if (closeName) skip--
      continue
    }

    if (openName) {
      const attrs = m[3] ?? ''
      const self = m[4] === '/'
      const local = localName(openName)
      if (!isAllowedElement(openName) || (local !== null && SMIL.has(local) && animatesHref(attrs))) {
        removed.add(local !== null && SMIL.has(local) ? 'href-animation' : openName)
        if (!self) skip = 1
        continue
      }
      if (local === 'style' && !self) inStyle++
      const kept = cleanAttributes(attrs, removed)
      out.push(`<${openName}${kept.length ? ` ${kept.join(' ')}` : ''}${self ? '/' : ''}>`)
      continue
    }
    if (closeName) {
      if (localName(closeName) === 'style') inStyle = Math.max(0, inStyle - 1)
      out.push(token)
      continue
    }
    if (token.startsWith('<!--')) continue
    if (/^<!DOCTYPE/i.test(token)) {
      removed.add('DOCTYPE')
      continue
    }
    if (token.startsWith('<?')) {
      if (leading && /^<\?xml\s/i.test(token)) out.push(token)
      else removed.add('processing-instruction')
      continue
    }
    if (token.startsWith('<![CDATA[')) {
      out.push(inStyle ? `<![CDATA[${cleanCss(token.slice(9, -3), removed)}]]>` : token)
      continue
    }
    // Text.
    out.push(inStyle ? cleanCss(token, removed) : token)
  }

  const result = out.join('')
  const malformed = wellFormed(result)
  if (malformed) return { ok: false, reason: `malformed: ${malformed}` }
  const left = svgProblems(Buffer.from(result))
  if (left) return { ok: false, reason: `unsafe: ${left}` }
  return { ok: true, bytes: Buffer.from(result), removed: [...removed].sort() }
}

/**
 * Independent check on a (sanitized) SVG: the first problem found, or null.
 * Kept separate from the sanitizer so a gap in one is caught by the other.
 */
export function svgProblems(bytes: Buffer): string | null {
  const text = bytes.toString('utf8')
  if (/<!ENTITY|<!DOCTYPE/i.test(text)) return 'DOCTYPE'
  for (const tag of text.matchAll(TAG)) {
    if (!isAllowedElement(tag[1]!)) return `<${tag[1]}>`
    const local = localName(tag[1]!)
    if (local !== null && SMIL.has(local) && animatesHref(tag[2] ?? '')) return 'href-animation'
    for (const match of (tag[2] ?? '').matchAll(ATTR)) {
      const attr = match[1]!
      const value = unquote(match[2])
      if (/^on/i.test(attr)) return 'on*'
      if (isHrefName(attr) && !allowedRef(value)) return 'href'
      if (/javascript:|vbscript:/i.test(decode(value))) return 'javascript:'
    }
  }
  const css = decodeCss(text)
  if (/@import/i.test(css)) return '@import'
  if (/image-set\(|expression\s*\(|-moz-binding|behavior\s*:/i.test(css)) return 'css'
  for (const m of css.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) if (!allowedRef(m[2] ?? '')) return 'url()'
  return null
}

/** Basic well-formedness: balanced tags, a single `svg` root. Null when fine. */
function wellFormed(text: string): string | null {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
  const stack: string[] = []
  let roots = 0
  const token = /<(\/?)([a-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|</gi
  for (const m of body.matchAll(token)) {
    if (m[2] === undefined) return 'unparsed `<`'
    const [, closing, name, , self] = m
    if (closing) {
      if (stack.pop() !== name) return `unclosed or misclosed <${name}>`
      continue
    }
    if (stack.length === 0) roots++
    if (!self) stack.push(name!)
  }
  if (stack.length) return `unclosed <${stack.at(-1)}>`
  if (roots !== 1) return `root element count ${roots}`
  if (!/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:svg:)?svg[\s>]/i.test(body)) return 'root is not svg'
  return null
}
