/**
 * SVG sanitizing — an ALLOW-LIST (elements + attributes), not a block-list. The
 * rule set is shared with Migrate: this file is a verbatim port of
 * `packages/media/src/svg.ts` (migrate feat/v3-media e3f971e), comments in
 * English; a change to the rules lands in both.
 *
 * Applied again here because the repository an import reads from is the
 * customer's: a file in `public/media/` may not have come through Migrate.
 * An SVG is an executable document: opened directly from the media host it
 * runs on that origin. A block-list missed foreign namespaces (an XHTML
 * `<meta http-equiv=refresh>` is an open redirect on the host), HTML elements
 * (`<img>` is a third-party request) and CSS escapes (`u\72l(`).
 *
 * Rules:
 *  - Elements: only {@link ELEMENTS} (unprefixed or `svg:`); anything else is
 *    removed WITH its content, as is an element declaring a non-SVG namespace
 *    (`xmlns="…xhtml"`). `set`/`animate*` that animate an `href` are removed.
 *  - Attributes: only {@link ATTRIBUTES}, `aria-*`, `role`. Never `on*`.
 *  - `href`/`xlink:href`: only a `#fragment` (in-document). Everything else,
 *    `data:` included, is removed.
 *  - In an attribute value `url(…)` may only be `url(#fragment)`; a value
 *    carrying `javascript:`/`vbscript:` is removed.
 *  - CSS (`style` attribute and `<style>`): XML entities and CSS escapes
 *    (`\HEX{1,6}` + whitespace, `\X`) are DECODED and comments dropped; then
 *    `@import`/`@font-face`/`@namespace` are removed and any `url()` other than
 *    `url(#fragment)` becomes `none`. If `image-set(`, `image(`, `expression(`,
 *    `-moz-binding`, `behavior:`, `javascript:` or `<` still remain, the whole
 *    CSS is dropped. The output is DECODED, cleaned CSS (nothing hidden behind
 *    an escape remains).
 *  - DOCTYPE, comments, processing instructions other than the xml
 *    declaration, and CDATA outside `<style>` are dropped.
 *  - The result must be well-formed (balanced tags, a single `svg` root) and
 *    pass an independent final check ({@link svgProblems}); otherwise the SVG
 *    is refused.
 */

export const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'desc', 'title', 'symbol', 'use', 'image', 'switch', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'textPath', 'clipPath', 'mask', 'marker', 'pattern', 'linearGradient',
  'radialGradient', 'stop', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite',
  'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA',
  'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset',
  'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence', 'style', 'view', 'animate',
  'animateTransform', 'animateMotion', 'set', 'mpath',
])

export const ATTRIBUTES = new Set([
  // core
  'id', 'class', 'style', 'lang', 'xml:lang', 'xml:space', 'tabindex', 'role', 'xmlns', 'xmlns:xlink', 'xmlns:svg', 'version', 'baseProfile',
  'href', 'xlink:href', 'xlink:title',
  // presentation
  'alignment-baseline', 'baseline-shift', 'clip', 'clip-path', 'clip-rule', 'color', 'color-interpolation',
  'color-interpolation-filters', 'color-rendering', 'cursor', 'direction', 'display', 'dominant-baseline', 'fill',
  'fill-opacity', 'fill-rule', 'filter', 'flood-color', 'flood-opacity', 'font-family', 'font-size', 'font-size-adjust',
  'font-stretch', 'font-style', 'font-variant', 'font-weight', 'image-rendering', 'isolation', 'kerning', 'letter-spacing',
  'lighting-color', 'marker-end', 'marker-mid', 'marker-start', 'mask', 'mix-blend-mode', 'opacity', 'overflow',
  'paint-order', 'pointer-events', 'shape-rendering', 'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width',
  'text-anchor', 'text-decoration', 'text-rendering', 'transform', 'transform-origin', 'unicode-bidi', 'vector-effect',
  'visibility', 'word-spacing', 'writing-mode',
  // geometry and text
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height', 'd', 'points',
  'pathLength', 'viewBox', 'preserveAspectRatio', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', 'startOffset',
  'method', 'spacing', 'side',
  // paint servers, clipping, masks, markers
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'patternUnits', 'patternContentUnits',
  'patternTransform', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'markerUnits', 'markerWidth', 'markerHeight',
  'refX', 'refY', 'orient',
  // filters
  'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'mode', 'type', 'values', 'operator', 'k1', 'k2', 'k3', 'k4',
  'order', 'kernelMatrix', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode', 'preserveAlpha', 'stdDeviation', 'scale',
  'xChannelSelector', 'yChannelSelector', 'radius', 'surfaceScale', 'diffuseConstant', 'specularConstant',
  'specularExponent', 'kernelUnitLength', 'azimuth', 'elevation', 'pointsAtX', 'pointsAtY', 'pointsAtZ',
  'limitingConeAngle', 'z', 'baseFrequency', 'numOctaves', 'seed', 'stitchTiles', 'tableValues', 'slope', 'intercept',
  'amplitude', 'exponent',
  // animation
  'attributeName', 'attributeType', 'begin', 'dur', 'end', 'min', 'max', 'restart', 'repeatCount', 'repeatDur', 'calcMode',
  'keyTimes', 'keySplines', 'keyPoints', 'from', 'to', 'by', 'additive', 'accumulate', 'path',
  // conditional processing and view
  'requiredExtensions', 'requiredFeatures', 'systemLanguage', 'viewTarget', 'zoomAndPan', 'media',
])

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

/** Every token in the stream: comment, CDATA, processing instruction, DOCTYPE, close, open, a lone `<` (malformed). */
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|</g
const ATTR = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/g

const unquote = (value: string | undefined): string => (value ?? '').replace(/^(["'])([\s\S]*)\1$/, '$2')

/** XML character references and the five predefined entities. */
export function xmlDecode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeChar(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&')
}
const safeChar = (code: number): string => (code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '\uFFFD')
const xmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** Comparison form: whitespace and control characters dropped (a browser runs `java\tscript:` too). */
const squash = (value: string): string =>
  [...value.replace(/\s+/g, '')].filter(ch => ch.charCodeAt(0) > 0x1F && ch.charCodeAt(0) !== 0x7F).join('')

const isFragment = (value: string): boolean => /^#[\w.:-]*$/.test(squash(value))
const SCRIPT_URL = /javascript:|vbscript:/i
/** Whether every `url(…)` in the value is a `url(#fragment)`. */
const onlyFragmentUrls = (value: string): boolean =>
  [...value.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)].every(m => isFragment(m[2] ?? ''))

/** Decode CSS escapes, drop comments. */
export function cssDecode(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?/gi, (_, hex: string) => safeChar(Number.parseInt(hex, 16)))
    .replace(/\\([\s\S])/g, '$1')
}

const CSS_FORBIDDEN = /image-set\s*\(|(?:^|[^-\w])image\s*\(|cross-fade\s*\(|element\s*\(|expression\s*\(|-moz-binding|behavior\s*:|javascript:|vbscript:|@import|</i

/**
 * CSS cleaning — input is XML-decoded text; output is DECODED CSS (no escapes), or `''` when it is not safe.
 */
export function cleanCss(raw: string, removed: Set<string>): string {
  let css = cssDecode(raw)
  css = css.replace(/@import\b[^;]*;?/gi, () => {
    removed.add('@import')
    return ''
  })
  css = css.replace(/@(?:font-face|namespace)\b[^{;]*(?:\{[^}]*\}|;)?/gi, () => {
    removed.add('@font-face')
    return ''
  })
  css = css.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (all, _q: string, target: string) => {
    if (isFragment(target)) return all
    removed.add('url()')
    return 'none'
  })
  if (CSS_FORBIDDEN.test(css)) {
    removed.add('css')
    return ''
  }
  return css
}

const localName = (name: string): { prefix: string, local: string } => {
  const i = name.indexOf(':')
  return i < 0 ? { prefix: '', local: name } : { prefix: name.slice(0, i), local: name.slice(i + 1) }
}

/** Whether an element is accepted (name + namespace + href animation). */
function elementAllowed(name: string, attrs: Array<[string, string]>): boolean {
  const { prefix, local } = localName(name)
  if ((prefix !== '' && prefix !== 'svg') || !ELEMENTS.has(local)) return false
  for (const [attr, value] of attrs) {
    if (attr === 'xmlns' && value !== SVG_NS) return false
    if (/^(?:set|animate|animateMotion|animateTransform)$/.test(local) && attr === 'attributeName' && /^(?:[\w-]+:)?href$/i.test(squash(value))) return false
  }
  return true
}

/** Whether an attribute and its value are accepted; `style` is cleaned separately. The value is XML-decoded. */
function attributeAllowed(attr: string, value: string): boolean {
  if (/^on/i.test(attr)) return false
  if (!(ATTRIBUTES.has(attr) || /^aria-[a-z-]+$/.test(attr))) return false
  if (attr === 'xmlns' && value !== SVG_NS) return false
  if (attr === 'xmlns:xlink' && value !== XLINK_NS) return false
  if (attr === 'xmlns:svg' && value !== SVG_NS) return false
  if ((attr === 'href' || attr === 'xlink:href') && !isFragment(value)) return false
  if (SCRIPT_URL.test(squash(value))) return false
  if (attr !== 'style' && !onlyFragmentUrls(value)) return false
  return true
}

const parseAttrs = (text: string): Array<[string, string]> =>
  [...text.matchAll(ATTR)].map(m => [m[1]!, xmlDecode(unquote(m[2]))])

export type SvgSanitized = { ok: true, bytes: Buffer, removed: string[] } | { ok: false, reason: string }

export function sanitizeSvg(input: Buffer): SvgSanitized {
  const removed = new Set<string>()
  const text = input.toString('utf8').replace(/^\uFEFF/, '')
  let out = ''
  let last = 0
  let skip = 0
  const stack: string[] = []
  let roots = 0
  let seenElement = false
  const inStyle = (): boolean => localName(stack.at(-1) ?? '').local === 'style'
  const emitText = (chunk: string): void => {
    if (!chunk || skip) return
    if (inStyle()) {
      out += xmlEscape(cleanCss(xmlDecode(chunk), removed))
      return
    }
    if (!stack.length) {
      if (chunk.trim()) removed.add('text outside root')
      return
    }
    out += chunk
  }

  for (const m of text.matchAll(TOKEN)) {
    emitText(text.slice(last, m.index))
    last = m.index + m[0].length
    const token = m[0]
    if (token === '<') return { ok: false, reason: 'malformed XML: unparsed `<`' }
    if (token.startsWith('<!--')) continue
    if (token.startsWith('<![CDATA[')) {
      if (!skip && inStyle()) out += xmlEscape(cleanCss(m[1] ?? '', removed))
      else if (!skip) removed.add('CDATA')
      continue
    }
    if (token.startsWith('<?')) {
      if (/^<\?xml\s/i.test(token) && !out && !seenElement) out += token
      else removed.add('processing instruction')
      continue
    }
    if (/^<!DOCTYPE/i.test(token)) {
      removed.add('DOCTYPE')
      continue
    }
    const closing = m[2]
    if (closing !== undefined) {
      if (skip) {
        skip--
        continue
      }
      if (stack.pop() !== closing) return { ok: false, reason: `malformed XML: misclosed </${closing}>` }
      out += `</${closing}>`
      continue
    }
    const name = m[3]!
    const selfClose = m[5] === '/'
    if (skip) {
      if (!selfClose) skip++
      continue
    }
    const attrs = parseAttrs(m[4] ?? '')
    if (!seenElement && localName(name).local !== 'svg') return { ok: false, reason: 'root is not svg' }
    seenElement = true
    if (!elementAllowed(name, attrs)) {
      removed.add(`<${name}>`)
      if (!selfClose) skip = 1
      continue
    }
    if (!stack.length) roots++
    const kept: string[] = []
    for (const [attr, value] of attrs) {
      if (!attributeAllowed(attr, value)) {
        removed.add(/^on/i.test(attr) ? 'on*' : attr.includes('href') ? 'href' : `@${attr}`)
        continue
      }
      if (attr === 'style') {
        const css = cleanCss(value, removed)
        if (css.trim()) kept.push(`style="${xmlEscape(css)}"`)
        continue
      }
      kept.push(`${attr}="${xmlEscape(value)}"`)
    }
    out += `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClose ? '/' : ''}>`
    if (!selfClose) stack.push(name)
  }
  emitText(text.slice(last))
  if (skip || stack.length) return { ok: false, reason: `malformed XML: unclosed <${stack.at(-1) ?? 'element'}>` }
  if (roots !== 1) return { ok: false, reason: `malformed XML: root element count ${roots}` }
  const left = svgProblems(Buffer.from(out))
  if (left) return { ok: false, reason: `unsafe: ${left}` }
  return { ok: true, bytes: Buffer.from(out), removed: [...removed].sort() }
}

/**
 * Independent final check — runs apart from the sanitizer so the sanitizer's
 * blind spots are caught here: an element/attribute outside the allow-lists, a
 * non-`#` href, a script URL, a non-`#` url(), a forbidden construct in decoded
 * CSS, DOCTYPE/ENTITY.
 *
 * @returns null when there is no problem
 */
export function svgProblems(bytes: Buffer): string | null {
  const text = bytes.toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return 'DOCTYPE'
  if (/<\?(?!xml\s)/i.test(text)) return 'processing instruction'
  let styleDepth = 0
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    if (styleDepth) {
      const css = cssDecode(xmlDecode(text.slice(last, m.index)))
      if (CSS_FORBIDDEN.test(css) || !onlyFragmentUrls(css)) return 'style'
    }
    last = m.index + m[0].length
    if (m[0] === '<') return 'malformed `<`'
    if (m[1] !== undefined && styleDepth) {
      const css = cssDecode(m[1])
      if (CSS_FORBIDDEN.test(css) || !onlyFragmentUrls(css)) return 'style'
    }
    if (m[2] !== undefined) {
      if (localName(m[2]).local === 'style') styleDepth = Math.max(0, styleDepth - 1)
      continue
    }
    if (m[3] === undefined) continue
    const attrs = parseAttrs(m[4] ?? '')
    if (!elementAllowed(m[3], attrs)) return `<${m[3]}>`
    for (const [attr, value] of attrs) {
      if (!attributeAllowed(attr, value)) return `@${attr}`
      if (attr === 'style') {
        const css = cssDecode(value)
        if (CSS_FORBIDDEN.test(css) || !onlyFragmentUrls(css)) return 'style'
      }
    }
    if (localName(m[3]).local === 'style' && m[5] !== '/') styleDepth++
  }
  return null
}
