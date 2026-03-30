/**
 * Command palette — search engine + action hub.
 *
 * Prefix modes:
 *   (empty) → global search (models, entries, vocab, branches, workspaces)
 *   >       → commands only
 *   @model  → search within a specific model's entries
 *   #       → vocabulary terms
 *   !       → branches
 *   ?       → help
 */

import type { CommandDefinition } from '~/utils/command-registry'
import { getCommands, GROUP_LABELS } from '~/utils/command-registry'
import { getModelKindIcon } from '~/utils/model-icons'

export interface ResultItem {
  id: string
  label: string
  sublabel?: string
  icon: string
  group: string
  type: string
  keywords?: string[]
  action: () => void
}

export type ParsedInput = {
  mode: 'global' | 'command' | 'model' | 'vocab' | 'branch' | 'help'
  query: string
  modelId?: string
}

/** Pending action emitted by CommandPalette, consumed by pages */
export interface PendingAction {
  type: 'send-prompt' | 'open-project-settings' | 'connect-repo'
  payload?: string
}

const RECENT_KEY = 'contentrain-recent-commands'
const MAX_RECENT = 8

export function useCommandPalette() {
  const open = useState('command-palette-open', () => false)
  const pendingAction = useState<PendingAction | null>('command-palette-action', () => null)

  function toggle() {
    open.value = !open.value
  }

  /** Emit an action for consuming pages (e.g., sendPrompt, openProjectSettings) */
  function emitAction(action: PendingAction) {
    pendingAction.value = action
  }

  /** Consume and clear the pending action */
  function consumeAction(): PendingAction | null {
    const action = pendingAction.value
    pendingAction.value = null
    return action
  }

  // ── Recent items (localStorage) ────────────────────────────

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

  // ── Input parsing ──────────────────────────────────────────

  function parseInput(raw: string): ParsedInput {
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

  // ── Fuzzy match ────────────────────────────────────────────

  function matches(text: string, query: string): boolean {
    if (!query) return true
    return text.toLowerCase().includes(query.toLowerCase())
  }

  // ── Result building ────────────────────────────────────────

  interface BuildContext {
    mode: ParsedInput['mode']
    query: string
    modelId?: string
    isInProject: boolean
    isDark: boolean
    currentModelId: string
    /** Translation function */
    t: (key: string) => string
    /** Reactive data sources */
    models: Array<{ id: string, name: string, kind?: string, type?: string, domain?: string }>
    branches: Array<{ name: string, sha: string }>
    conversations: Array<{ id: string, title: string | null, updated_at: string }>
    projects: Array<{ id: string, repo_full_name: string, detected_stack?: string | null }>
    workspaces: Array<{ id: string, name: string, slug: string, plan: string }>
    snapshot: { vocabulary?: Record<string, Record<string, string>>, content?: Record<string, { count: number }> } | null
    /** Action handlers — resolved by component */
    onAction: (actionKey: string, payload?: Record<string, unknown>) => void
    onRecent: (item: { id: string, type: string }) => void
    onLoadConversation: (convId: string) => void
    onNavigateModel: (modelId: string, modelName: string) => void
    onNavigateBranch: (branchName: string) => void
    onNavigateProject: (projectId: string) => void
    onNavigateWorkspace: (workspaceId: string, slug: string) => void
  }

  function buildResults(ctx: BuildContext): ResultItem[] {
    const { mode, query, modelId } = ctx
    const items: ResultItem[] = []

    // ── Recent (only when no query in global mode) ─────────
    if (mode === 'global' && !query) {
      for (const r of getRecent()) {
        items.push({
          id: `recent:${r.id}`,
          label: r.label,
          sublabel: r.sublabel,
          icon: r.icon,
          group: 'Recent',
          type: 'recent',
          action: () => ctx.onRecent(r),
        })
      }
    }

    // ── Commands ───────────────────────────────────────────
    if (mode === 'command' || (mode === 'global' && query.length > 0)) {
      const commands = getCommands({
        isDark: ctx.isDark,
        isInProject: ctx.isInProject,
        currentModelId: ctx.currentModelId,
      })

      for (const cmd of commands) {
        if (mode === 'command' || query.length >= 2) {
          const label = resolveLabel(cmd, ctx.t)
          if (matches(label, query) || cmd.keywords.some(k => matches(k, query))) {
            items.push({
              id: cmd.id,
              label,
              icon: cmd.icon,
              group: GROUP_LABELS[cmd.group],
              type: 'command',
              keywords: cmd.keywords,
              action: () => ctx.onAction(cmd.action, cmd.prompt ? { prompt: cmd.prompt } : undefined),
            })
          }
        }
      }
    }

    // ── Models ─────────────────────────────────────────────
    if (mode === 'global' && ctx.isInProject) {
      for (const model of ctx.models) {
        if (matches(model.name, query) || matches(model.id, query) || matches(model.domain ?? '', query)) {
          items.push({
            id: `model:${model.id}`,
            label: model.name,
            sublabel: `${model.kind ?? model.type ?? ''} · ${model.domain ?? ''}`,
            icon: getModelKindIcon(model.kind ?? model.type ?? ''),
            group: 'Models',
            type: 'model',
            action: () => ctx.onNavigateModel(model.id, model.name),
          })
        }
      }
    }

    // ── Vocabulary ─────────────────────────────────────────
    if ((mode === 'vocab' || mode === 'global') && ctx.isInProject) {
      const vocab = ctx.snapshot?.vocabulary
      if (vocab) {
        let count = 0
        for (const [term, translations] of Object.entries(vocab)) {
          const value = translations.en ?? Object.values(translations)[0] ?? ''
          if (matches(term, query) || matches(value, query)) {
            items.push({
              id: `vocab:${term}`,
              label: term,
              sublabel: value,
              icon: 'icon-[annon--book-library]',
              group: 'Vocabulary',
              type: 'vocab',
              action: () => ctx.onAction('open-vocabulary'),
            })
            count++
          }
          if (count >= 5) break
        }
      }
    }

    // ── Branches ───────────────────────────────────────────
    if ((mode === 'branch' || mode === 'global') && ctx.isInProject) {
      for (const branch of ctx.branches) {
        if (matches(branch.name, query)) {
          items.push({
            id: `branch:${branch.name}`,
            label: branch.name.replace('contentrain/', ''),
            sublabel: branch.sha.substring(0, 7),
            icon: 'icon-[annon--arrow-swap]',
            group: 'Branches',
            type: 'branch',
            action: () => ctx.onNavigateBranch(branch.name),
          })
        }
      }
    }

    // ── Conversations ──────────────────────────────────────
    if (mode === 'global' && ctx.isInProject && query.length >= 2) {
      let count = 0
      for (const conv of ctx.conversations) {
        if (matches(conv.title ?? '', query)) {
          items.push({
            id: `conv:${conv.id}`,
            label: conv.title || ctx.t('chat.untitled'),
            sublabel: new Date(conv.updated_at).toLocaleDateString(),
            icon: 'icon-[annon--comment-2]',
            group: 'Conversations',
            type: 'conversation',
            action: () => ctx.onLoadConversation(conv.id),
          })
          count++
        }
        if (count >= 3) break
      }
    }

    // ── Projects ───────────────────────────────────────────
    if (mode === 'global') {
      for (const project of ctx.projects) {
        if (matches(project.repo_full_name, query)) {
          items.push({
            id: `project:${project.id}`,
            label: project.repo_full_name.split('/').pop() ?? project.repo_full_name,
            sublabel: project.detected_stack ?? '',
            icon: 'icon-[annon--folder]',
            group: 'Projects',
            type: 'project',
            action: () => ctx.onNavigateProject(project.id),
          })
        }
      }
    }

    // ── Workspaces ─────────────────────────────────────────
    if (mode === 'global' && query.length >= 2) {
      for (const ws of ctx.workspaces) {
        if (matches(ws.name, query) || matches(ws.slug, query)) {
          items.push({
            id: `ws:${ws.id}`,
            label: ws.name,
            sublabel: ws.plan,
            icon: 'icon-[annon--briefcase]',
            group: 'Workspaces',
            type: 'workspace',
            action: () => ctx.onNavigateWorkspace(ws.id, ws.slug),
          })
        }
      }
    }

    // ── @model entries ─────────────────────────────────────
    if (mode === 'model' && modelId && ctx.isInProject) {
      const content = ctx.snapshot?.content
      if (content?.[modelId]) {
        items.push({
          id: `model-nav:${modelId}`,
          label: `Open ${modelId}`,
          sublabel: `${content[modelId].count} entries`,
          icon: 'icon-[annon--arrow-right]',
          group: `@${modelId}`,
          type: 'command',
          action: () => ctx.onNavigateModel(modelId, modelId),
        })
      }
    }

    // ── Help ───────────────────────────────────────────────
    if (mode === 'help') {
      const helps = [
        { id: 'help:search', label: 'Global search', sublabel: 'Type anything to search models, entries, vocabulary', icon: 'icon-[annon--search]' },
        { id: 'help:commands', label: '> Commands', sublabel: 'Type > to see available actions', icon: 'icon-[annon--code]' },
        { id: 'help:vocab', label: '# Vocabulary', sublabel: 'Type # to search vocabulary terms', icon: 'icon-[annon--book-library]' },
        { id: 'help:branch', label: '! Branches', sublabel: 'Type ! to search content branches', icon: 'icon-[annon--arrow-swap]' },
        { id: 'help:model', label: '@model Search', sublabel: 'Type @modelId to search within a model', icon: 'icon-[annon--layers]' },
        { id: 'help:shortcut', label: '⌘K', sublabel: 'Open this palette from anywhere', icon: 'icon-[annon--key]' },
      ]
      for (const h of helps) {
        if (matches(h.label, query) || matches(h.sublabel, query)) {
          items.push({ ...h, group: 'Help', type: 'help', action: () => {} })
        }
      }
    }

    return items
  }

  function groupResults(items: ResultItem[]): Record<string, ResultItem[]> {
    const groups: Record<string, ResultItem[]> = {}
    for (const item of items) {
      if (!groups[item.group]) groups[item.group] = []
      groups[item.group]!.push(item)
    }
    return groups
  }

  return {
    open,
    toggle,
    pendingAction: readonly(pendingAction),
    emitAction,
    consumeAction,
    getRecent,
    addRecent,
    parseInput,
    matches,
    buildResults,
    groupResults,
  }
}

/** Resolve label from CommandDefinition (labelKey takes precedence) */
function resolveLabel(cmd: CommandDefinition, t: (key: string) => string): string {
  if (cmd.labelKey) return t(cmd.labelKey)
  return cmd.label ?? cmd.id
}
