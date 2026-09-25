/**
 * SVG sanitizing — the same rules Migrate applies when it writes a site's SVGs
 * (`packages/media/src/svg.ts` in the migrate repo), applied again here because
 * the repository an import reads from is the customer's: a file in
 * `public/media/` may not have come through Migrate at all.
 *
 * An SVG is an executable document: opened directly from the media host, a
 * script inside it runs on that origin. Removed: `script`, `foreignObject`
 * (embeds HTML), `iframe`/`embed`/`object`, XML Events `handler`/`listener`,
 * `set`/`animate` that animate an `href`, every `on*` attribute, every `href`
 * other than a `#fragment` or a raster `data:image` (external `<use>`
 * included), `@import` and any `url()` other than `#`/raster `data:` in styles,
 * `-moz-binding`/`behavior`/`expression(`, DOCTYPE (entity definitions: XXE,
 * billion laughs) and processing instructions other than the xml declaration.
 *
 * Allow-list approach: an `href`/`url()` value is judged after decoding
 * character references and dropping whitespace and control characters, so
 * `&#106;avascript:`, `java\tscript:` and `java\u0001script:` fall too. The
 * result must then pass an independent check ({@link svgProblems}) and a
 * well-formedness check; if either finds anything, the SVG is refused.
 */

const DANGEROUS_ELEMENTS = ['script', 'foreignObject', 'iframe', 'embed', 'object', 'handler', 'listener']
const PREFIX = '(?:[\\w-]+:)?'

/** Attribute parser: name, `=`, quoted or unquoted value. */
const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g
/** An opening or self-closing tag; a `>` inside quotes does not end it. */
const TAG = /<([a-zA-Z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>/g

const unquote = (value: string | undefined): string => (value ?? '').replace(/^(["'])([\s\S]*)\1$/, '$2')

/** Resolve character references and drop whitespace/control characters — for allow-list comparison only. */
function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
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

const allowedRef = (raw: string): boolean => {
  const value = decode(raw)
  return value === '' || value.startsWith('#') || /^data:image\/(?:png|jpe?g|gif|webp|avif);/i.test(value)
}

const isHrefName = (name: string): boolean => /^(?:[\w-]+:)?href$/i.test(name)

function cleanCss(css: string, removed: Set<string>): string {
  let out = css.replace(/@import\b[^;]*;?/gi, () => {
    removed.add('@import')
    return ''
  })
  out = out.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (all, _q: string, target: string) => {
    if (allowedRef(target)) return all
    removed.add('url()')
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

export type SvgSanitized = { ok: true, bytes: Buffer, removed: string[] } | { ok: false, reason: string }

export function sanitizeSvg(input: Buffer): SvgSanitized {
  const removed = new Set<string>()
  let text = input.toString('utf8').replace(/^\uFEFF/, '')

  // DOCTYPE (internal subset included) and processing instructions other than the xml declaration.
  text = text.replace(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/gi, () => {
    removed.add('DOCTYPE')
    return ''
  })
  text = text.replace(/<\?(?!xml\s)[\s\S]*?\?>/gi, () => {
    removed.add('processing-instruction')
    return ''
  })

  // Dangerous elements with their content, namespace-prefixed spellings included; repeated until stable (nesting).
  for (let pass = 0; pass < 5; pass++) {
    const before = text
    for (const name of DANGEROUS_ELEMENTS) {
      const pair = new RegExp(`<${PREFIX}${name}\\b[^>]*?(?:/>|>[\\s\\S]*?</${PREFIX}${name}\\s*>)`, 'gi')
      text = text.replace(pair, () => {
        removed.add(name)
        return ''
      })
    }
    // SMIL that animates an `href`: `<set attributeName="href" to="javascript:…">`.
    text = text.replace(new RegExp(`<${PREFIX}(set|animate|animateMotion|animateTransform)\\b[^>]*attributeName\\s*=\\s*["']?(?:[\\w-]+:)?href[^>]*?(?:/>|>[\\s\\S]*?</${PREFIX}\\1\\s*>)`, 'gi'), () => {
      removed.add('href-animation')
      return ''
    })
    if (text === before) break
  }

  // Attributes.
  text = text.replace(TAG, (_all, name: string, attrs: string, selfClose: string) => {
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
      if (attr.toLowerCase() === 'style') {
        const clean = cleanCss(value, removed)
        kept.push(`${attr}="${clean.replace(/"/g, '&quot;')}"`)
        continue
      }
      kept.push(raw === undefined ? attr : `${attr}=${raw}`)
    }
    return `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClose ? '/' : ''}>`
  })

  // `<style>` bodies.
  text = text.replace(/(<(?:[\w-]+:)?style\b[^>]*>)([\s\S]*?)(<\/(?:[\w-]+:)?style\s*>)/gi, (_all, open: string, css: string, close: string) => open + cleanCss(css, removed) + close)

  const malformed = wellFormed(text)
  if (malformed) return { ok: false, reason: `malformed: ${malformed}` }
  const left = svgProblems(Buffer.from(text))
  if (left) return { ok: false, reason: `unsafe: ${left}` }
  return { ok: true, bytes: Buffer.from(text), removed: [...removed].sort() }
}

/**
 * Independent check on a (sanitized) SVG: the first problem found, or null.
 * Kept separate from the sanitizer so a gap in one is caught by the other.
 */
export function svgProblems(bytes: Buffer): string | null {
  const text = bytes.toString('utf8')
  for (const name of DANGEROUS_ELEMENTS) if (new RegExp(`<${PREFIX}${name}[\\s>/]`, 'i').test(text)) return name
  if (/<!ENTITY|<!DOCTYPE/i.test(text)) return 'DOCTYPE'
  if (/@import/i.test(text)) return '@import'
  for (const tag of text.matchAll(TAG)) {
    for (const match of (tag[2] ?? '').matchAll(ATTR)) {
      const attr = match[1]!
      const value = unquote(match[2])
      if (/^on/i.test(attr)) return 'on*'
      if (isHrefName(attr) && !allowedRef(value)) return 'href'
      if (/javascript:|vbscript:/i.test(decode(value))) return 'javascript:'
    }
  }
  for (const m of text.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) if (!allowedRef(m[2] ?? '')) return 'url()'
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
  const token = /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|</g
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
  if (!/^\s*(?:<!--[\s\S]*?-->\s*)*<(?:[\w-]+:)?svg[\s>]/i.test(body)) return 'root is not svg'
  return null
}
