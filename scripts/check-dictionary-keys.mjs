/**
 * Dictionary key checker — finds keys used in code but not defined in
 * the Contentrain content layer. A missing key renders as the raw key
 * string in the UI (e.g. a toast showing "common.copied").
 *
 * Consumers scanned:
 *   t('key')                        → ui-strings (client)
 *   labelKey / altLabelKey: 'key'   → ui-strings (command registry, via t())
 *   errorMessage('key')             → error-messages (server)
 *   agentMessage('key')             → agent-messages (server)
 *   agentPrompt('key')              → agent-prompts (server)
 *   runEnterpriseRoute(name, 'key') → error-messages
 *   emailTemplate('slug') / sendBillingEmail(id, 'slug') → email-templates
 *
 * Dynamic usages (template literals, variables) are listed for manual
 * review but do not fail the check.
 *
 * Usage: node scripts/check-dictionary-keys.mjs   (exit 1 on missing keys)
 */
/* eslint-disable no-console -- CLI reporter */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

// ── Load defined keys ──
const loadDict = file => new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, '.contentrain/content/system', file), 'utf8'))))
const dicts = {
  'ui-strings': loadDict('ui-strings/en.json'),
  'error-messages': loadDict('error-messages/en.json'),
  'agent-messages': loadDict('agent-messages/en.json'),
  'agent-prompts': loadDict('agent-prompts/en.json'),
}
const emailDir = join(ROOT, '.contentrain/content/system/email-templates')
const emailSlugs = new Set()
for (const f of readdirSync(emailDir)) {
  if (!f.endsWith('.json')) continue
  const data = JSON.parse(readFileSync(join(emailDir, f), 'utf8'))
  const entries = Array.isArray(data) ? data : Object.values(data)
  for (const e of entries) {
    if (e && typeof e === 'object' && e.slug) emailSlugs.add(e.slug)
    if (e && typeof e === 'object') {
      for (const v of Object.values(e)) {
        if (v && typeof v === 'object' && v.slug) emailSlugs.add(v.slug)
      }
    }
  }
}

// ── Walk source files ──
const SCAN_DIRS = ['app', 'server', 'shared', 'ee']
const SKIP = new Set(['node_modules', '.nuxt', '.output', 'dist', 'coverage'])
const files = []
function walk(dir) {
  let items
  try {
    items = readdirSync(dir)
  }
  catch {
    return
  }
  for (const item of items) {
    if (SKIP.has(item)) continue
    const p = join(dir, item)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(?:ts|vue|mjs)$/.test(item)) files.push(p)
  }
}
for (const d of SCAN_DIRS) walk(join(ROOT, d))

// ── Extract usages ──
const PATTERNS = [
  { re: /\bt\(\s*(['"])([^'"\n]+)\1/g, dict: 'ui-strings' },
  { re: /\berrorMessage\(\s*(['"])([^'"\n]+)\1/g, dict: 'error-messages' },
  { re: /\bagentMessage\(\s*(['"])([^'"\n]+)\1/g, dict: 'agent-messages' },
  { re: /\bagentPrompt\(\s*(['"])([^'"\n]+)\1/g, dict: 'agent-prompts' },
  { re: /\bemailTemplate\(\s*\n?\s*(['"])([^'"\n]+)\1/g, dict: 'email-templates' },
  { re: /\bsendBillingEmail\(\s*[^,]+,\s*(['"])([^'"\n]+)\1/g, dict: 'email-templates' },
  { re: /\b(?:altLabelKey|labelKey):\s*(['"])([^'"\n]+)\1/g, dict: 'ui-strings' },
  { re: /\brunEnterpriseRoute(?:<[^>]*>)?\(\s*\n?\s*(['"])[^'"\n]+\1,\s*\n?\s*(['"])([^'"\n]+)\2/g, dict: 'error-messages', keyIdx: 3 },
]
const DYNAMIC_RE = /\b(t|errorMessage|agentMessage|agentPrompt|emailTemplate)\(\s*(`[^`\n]*\$\{[^`\n]*`|[a-z_$][\w.$?]*)\s*[,)]/gi
const IGNORED_VARS = new Set(['key', 'slug', 'templateslug', 'featuremessagekey', 'messagekey', 'labelkey'])

const missing = new Map()
const dynamic = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const rel = file.slice(ROOT.length + 1)
  const lineOf = idx => src.slice(0, idx).split('\n').length

  for (const { re, dict, keyIdx } of PATTERNS) {
    re.lastIndex = 0
    for (let m; (m = re.exec(src));) {
      const key = m[keyIdx ?? 2]
      const defined = dict === 'email-templates' ? emailSlugs : dicts[dict]
      if (!defined.has(key)) {
        if (!missing.has(dict)) missing.set(dict, new Map())
        const entry = missing.get(dict)
        if (!entry.has(key)) entry.set(key, [])
        entry.get(key).push(`${rel}:${lineOf(m.index)}`)
      }
    }
  }

  DYNAMIC_RE.lastIndex = 0
  for (let m; (m = DYNAMIC_RE.exec(src));) {
    const arg = m[2]
    if (rel.endsWith('content-strings.ts') || rel.endsWith('useContent.ts')) continue
    if (!arg.startsWith('`') && IGNORED_VARS.has(arg.toLowerCase())) continue
    dynamic.push(`${rel}:${lineOf(m.index)}  ${m[1]}(${arg})`)
  }
}

// ── Report ──
let total = 0
for (const [dict, entries] of [...missing.entries()].sort()) {
  console.log(`\n${dict}: ${entries.size} missing key(s)`)
  for (const [key, locs] of [...entries.entries()].sort()) {
    total += 1
    console.log(`  ${key}`)
    for (const loc of locs.slice(0, 3)) console.log(`      ${loc}`)
    if (locs.length > 3) console.log(`      … +${locs.length - 3} more`)
  }
}

if (dynamic.length) {
  console.log(`\nDynamic usages (manual review only, not failures): ${dynamic.length}`)
  for (const d of dynamic) console.log(`  ${d}`)
}

if (total > 0) {
  console.error(`\n✖ ${total} dictionary key(s) used in code but not defined in the content layer.`)
  process.exit(1)
}
console.log('\n✓ All literal dictionary keys are defined.')
