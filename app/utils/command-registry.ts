/**
 * Command palette registry — all command definitions as pure data.
 * No composable dependencies, no side effects.
 */

export type CommandScope = 'global' | 'workspace' | 'project'
export type CommandGroup = 'appearance' | 'navigation' | 'workspace' | 'project' | 'ai-model' | 'agent'

export interface CommandDefinition {
  id: string
  labelKey?: string
  label?: string
  icon: string
  /** Alternate icon getter for togglable commands (e.g. dark mode) */
  altIcon?: string
  /** Alternate label key for togglable commands */
  altLabelKey?: string
  keywords: string[]
  group: CommandGroup
  scope: CommandScope
  /** Action key resolved by the component */
  action: string
  /** Chat prompt to send (for agent commands) */
  prompt?: string
}

/** Context passed to getCommands to filter and customize commands */
export interface CommandContext {
  isDark: boolean
  isInProject: boolean
  currentModelId: string
}

/**
 * Returns all static command definitions filtered by scope.
 */
export function getCommands(ctx: CommandContext): CommandDefinition[] {
  const commands: CommandDefinition[] = []

  // ─── Appearance ──────────────────────────────────────────
  commands.push({
    id: 'cmd:dark-mode',
    labelKey: ctx.isDark ? 'common.light_mode' : 'common.dark_mode',
    icon: ctx.isDark ? 'icon-[annon--sun]' : 'icon-[annon--moon]',
    keywords: ['theme', 'dark', 'light', 'mode', 'appearance'],
    group: 'appearance',
    scope: 'global',
    action: 'toggle-theme',
  })

  // ─── Global Navigation ───────────────────────────────────
  commands.push({
    id: 'cmd:sign-out',
    labelKey: 'common.sign_out',
    icon: 'icon-[annon--log-out]',
    keywords: ['sign out', 'logout', 'exit', 'quit'],
    group: 'navigation',
    scope: 'global',
    action: 'sign-out',
  })

  commands.push({
    id: 'cmd:switch-workspace',
    label: 'Switch workspace',
    icon: 'icon-[annon--arrow-swap]',
    keywords: ['workspace', 'switch', 'change', 'home'],
    group: 'navigation',
    scope: 'global',
    action: 'switch-workspace',
  })

  commands.push({
    id: 'cmd:create-workspace',
    label: 'Create workspace',
    icon: 'icon-[annon--plus-circle]',
    keywords: ['workspace', 'new', 'create'],
    group: 'navigation',
    scope: 'global',
    action: 'create-workspace',
  })

  // ─── Workspace ───────────────────────────────────────────
  commands.push({
    id: 'cmd:settings',
    labelKey: 'common.settings',
    icon: 'icon-[annon--gear]',
    keywords: ['settings', 'workspace', 'preferences'],
    group: 'workspace',
    scope: 'workspace',
    action: 'ws-settings',
  })

  commands.push({
    id: 'cmd:ws-members',
    labelKey: 'settings.members_tab',
    icon: 'icon-[annon--user-group]',
    keywords: ['members', 'team', 'invite', 'people', 'roles'],
    group: 'workspace',
    scope: 'workspace',
    action: 'ws-members',
  })

  commands.push({
    id: 'cmd:ws-github',
    labelKey: 'settings.github_tab',
    icon: 'icon-[annon--code]',
    keywords: ['github', 'installation', 'repos', 'git'],
    group: 'workspace',
    scope: 'workspace',
    action: 'ws-github',
  })

  commands.push({
    id: 'cmd:ws-ai-keys',
    labelKey: 'settings.ai_tab',
    icon: 'icon-[annon--key]',
    keywords: ['ai', 'keys', 'api', 'byoa', 'anthropic', 'claude'],
    group: 'workspace',
    scope: 'workspace',
    action: 'ws-ai-keys',
  })

  commands.push({
    id: 'cmd:connect-repo',
    labelKey: 'projects.connect_repo',
    icon: 'icon-[annon--link]',
    keywords: ['connect', 'repo', 'repository', 'new project', 'add project'],
    group: 'workspace',
    scope: 'workspace',
    action: 'connect-repo',
  })

  // ─── Project Navigation ──────────────────────────────────
  if (ctx.isInProject) {
    commands.push({
      id: 'cmd:overview',
      label: 'Project overview',
      icon: 'icon-[annon--home-2]',
      keywords: ['overview', 'home', 'dashboard', 'back'],
      group: 'project',
      scope: 'project',
      action: 'project-overview',
    })

    commands.push({
      id: 'cmd:new-conversation',
      labelKey: 'chat.new_conversation',
      icon: 'icon-[annon--plus-circle]',
      keywords: ['chat', 'new', 'conversation', 'clear'],
      group: 'project',
      scope: 'project',
      action: 'new-conversation',
    })

    commands.push({
      id: 'cmd:vocabulary',
      labelKey: 'content.vocabulary',
      icon: 'icon-[annon--book-library]',
      keywords: ['vocabulary', 'terms', 'glossary', 'dictionary'],
      group: 'project',
      scope: 'project',
      action: 'open-vocabulary',
    })

    commands.push({
      id: 'cmd:cdn',
      labelKey: 'cdn.title',
      icon: 'icon-[annon--globe]',
      keywords: ['cdn', 'delivery', 'api', 'build'],
      group: 'project',
      scope: 'project',
      action: 'open-cdn',
    })

    commands.push({
      id: 'cmd:media',
      label: 'Media library',
      icon: 'icon-[annon--photo]',
      keywords: ['media', 'assets', 'images', 'files', 'library', 'upload'],
      group: 'project',
      scope: 'project',
      action: 'open-media',
    })

    commands.push({
      id: 'cmd:health',
      label: 'Project health',
      icon: 'icon-[annon--heart]',
      keywords: ['health', 'score', 'validation', 'warnings', 'quality'],
      group: 'project',
      scope: 'project',
      action: 'open-health',
    })

    commands.push({
      id: 'cmd:project-settings',
      label: 'Project settings',
      icon: 'icon-[annon--gear]',
      keywords: ['settings', 'project', 'config', 'configuration'],
      group: 'project',
      scope: 'project',
      action: 'open-project-settings',
    })

    commands.push({
      id: 'cmd:webhooks',
      labelKey: 'webhooks.title',
      icon: 'icon-[annon--send]',
      keywords: ['webhooks', 'hooks', 'events', 'notifications', 'integrations'],
      group: 'project',
      scope: 'project',
      action: 'open-webhooks',
    })

    commands.push({
      id: 'cmd:conversation-keys',
      label: 'Conversation API',
      icon: 'icon-[annon--key]',
      keywords: ['conversation', 'api', 'keys', 'external', 'bot', 'integration'],
      group: 'project',
      scope: 'project',
      action: 'open-conversation-keys',
    })

    // ─── AI Model Selection ──────────────────────────────────
    commands.push({
      id: 'cmd:model-haiku',
      label: 'Switch to Haiku 4.5',
      icon: 'icon-[annon--flash]',
      keywords: ['haiku', 'fast', 'economic', 'model', 'ai', 'switch'],
      group: 'ai-model',
      scope: 'project',
      action: 'set-model-haiku',
    })

    commands.push({
      id: 'cmd:model-sonnet',
      label: 'Switch to Sonnet 4',
      icon: 'icon-[annon--star]',
      keywords: ['sonnet', 'balanced', 'model', 'ai', 'switch'],
      group: 'ai-model',
      scope: 'project',
      action: 'set-model-sonnet',
    })

    commands.push({
      id: 'cmd:model-opus',
      label: 'Switch to Opus 4',
      icon: 'icon-[annon--diamond]',
      keywords: ['opus', 'capable', 'best', 'model', 'ai', 'switch'],
      group: 'ai-model',
      scope: 'project',
      action: 'set-model-opus',
    })

    // ─── Agent Commands (send chat prompt) ───────────────────
    commands.push({
      id: 'cmd:add-model',
      labelKey: 'content.add_model',
      icon: 'icon-[annon--plus]',
      keywords: ['create', 'model', 'new', 'schema'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Create a new content model. Ask me what kind of content I want to manage.',
    })

    commands.push({
      id: 'cmd:add-entry',
      labelKey: 'content.add_entry',
      icon: 'icon-[annon--file-text]',
      keywords: ['create', 'entry', 'new', 'content', 'add'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Create a new entry. Ask me which model and what content.',
    })

    commands.push({
      id: 'cmd:translate',
      label: 'Translate content',
      icon: 'icon-[annon--globe]',
      keywords: ['translate', 'locale', 'language', 'i18n'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Translate content to another locale. Ask me which model and target language.',
    })

    commands.push({
      id: 'cmd:validate-schema',
      label: 'Validate schema',
      icon: 'icon-[annon--check-circle]',
      keywords: ['validate', 'schema', 'check', 'integrity'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Run schema validation and health check on this project. Report any issues found.',
    })

    commands.push({
      id: 'cmd:seo-audit',
      label: 'SEO audit',
      icon: 'icon-[annon--search]',
      keywords: ['seo', 'audit', 'meta', 'optimization'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Run an SEO audit on all content models. Check for missing meta descriptions, titles, and slugs.',
    })

    commands.push({
      id: 'cmd:analyze-quality',
      label: 'Analyze content quality',
      icon: 'icon-[annon--chart]',
      keywords: ['analyze', 'quality', 'score', 'report'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Analyze content quality across all models. Give me a quality score and improvement suggestions.',
    })

    commands.push({
      id: 'cmd:locale-parity',
      label: 'Check translations',
      icon: 'icon-[annon--globe]',
      keywords: ['locale', 'parity', 'translations', 'missing', 'i18n'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Check locale parity — find missing translations across all models and locales.',
    })

    commands.push({
      id: 'cmd:stale-content',
      label: 'Find stale content',
      icon: 'icon-[annon--clock]',
      keywords: ['stale', 'old', 'outdated', 'unused', 'cleanup'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Find stale content that hasn\'t been updated recently. Highlight entries that may need review.',
    })

    commands.push({
      id: 'cmd:upload-media',
      label: 'Upload media',
      icon: 'icon-[annon--upload]',
      keywords: ['upload', 'media', 'image', 'url', 'file'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Upload media from a URL. Ask me for the URL and details.',
    })

    commands.push({
      id: 'cmd:copy-locale',
      label: 'Copy locale',
      icon: 'icon-[annon--copy]',
      keywords: ['copy', 'locale', 'bootstrap', 'language', 'duplicate'],
      group: 'agent',
      scope: 'project',
      action: 'send-prompt',
      prompt: 'Bootstrap a new locale by copying content from the source locale. Ask me which source and target languages.',
    })
  }

  return commands
}

/** Group label for display */
export const GROUP_LABELS: Record<CommandGroup, string> = {
  'appearance': 'Appearance',
  'navigation': 'Navigation',
  'workspace': 'Workspace',
  'project': 'Project',
  'ai-model': 'AI Model',
  'agent': 'Agent Actions',
}
