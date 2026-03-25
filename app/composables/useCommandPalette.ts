/**
 * Command palette — search engine + action hub.
 *
 * Prefix modes:
 *   (empty) → global search (models, entries, vocab, branches)
 *   >       → commands only
 *   @model  → search within a specific model's entries
 *   #       → vocabulary terms
 *   !       → branches
 */

export interface CommandItem {
  id: string
  type: 'model' | 'entry' | 'vocab' | 'branch' | 'conversation' | 'command' | 'recent'
  label: string
  sublabel?: string
  icon: string
  group: string
  keywords?: string[]
  action: () => void | Promise<void>
}

const RECENT_KEY = 'contentrain-recent-commands'
const MAX_RECENT = 8

export function useCommandPalette() {
  const open = useState('command-palette-open', () => false)

  function toggle() {
    open.value = !open.value
  }

  // Recent items from localStorage
  function getRecent(): Array<{ id: string, label: string, sublabel?: string, icon: string, type: string }> {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    }
    catch { return [] }
  }

  function addRecent(item: { id: string, label: string, sublabel?: string, icon: string, type: string }) {
    const recent = getRecent().filter(r => r.id !== item.id)
    recent.unshift(item)
    if (recent.length > MAX_RECENT) recent.pop()
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent))
  }

  // Parse search input for prefix mode
  function parseInput(raw: string): { mode: 'global' | 'command' | 'model' | 'vocab' | 'branch' | 'help', query: string, modelId?: string } {
    const trimmed = raw.trim()
    if (trimmed.startsWith('>')) return { mode: 'command', query: trimmed.slice(1).trim() }
    if (trimmed.startsWith('#')) return { mode: 'vocab', query: trimmed.slice(1).trim() }
    if (trimmed.startsWith('!')) return { mode: 'branch', query: trimmed.slice(1).trim() }
    if (trimmed.startsWith('?')) return { mode: 'help', query: trimmed.slice(1).trim() }
    if (trimmed.startsWith('@')) {
      const spaceIdx = trimmed.indexOf(' ')
      if (spaceIdx > 1) {
        return { mode: 'model', modelId: trimmed.slice(1, spaceIdx), query: trimmed.slice(spaceIdx + 1).trim() }
      }
      return { mode: 'model', modelId: trimmed.slice(1), query: '' }
    }
    return { mode: 'global', query: trimmed }
  }

  // Fuzzy match
  function matches(text: string, query: string): boolean {
    if (!query) return true
    return text.toLowerCase().includes(query.toLowerCase())
  }

  return {
    open,
    toggle,
    getRecent,
    addRecent,
    parseInput,
    matches,
  }
}
