import { describe, expect, it } from 'vitest'
import {
  ADVERTISED_SCOPES,
  SUPPORTED_SCOPES,
  advertisedScopes,
  normalizeScope,
  scopeAllowsTool,
  scopeForTool,
  scopeIncludes,
  toolsForScope,
} from '../../server/utils/oauth-server/scopes'
import {
  MEDIA_READ_TOOL_NAMES,
  MEDIA_TOOL_NAMES,
  MEDIA_WRITE_TOOL_NAMES,
  METADATA_TOOL_NAMES,
  READ_TOOL_NAMES,
  STUDIO_OWNED_LIFECYCLE_TOOLS,
  WRITE_TOOL_NAMES,
} from '../../server/utils/mcp-tool-classes'

describe('scope registry', () => {
  it('registers six scopes with a base-four advertised set', () => {
    expect(SUPPORTED_SCOPES).toHaveLength(6)
    expect(ADVERTISED_SCOPES).toEqual([
      'content:read',
      'content:write',
      'project:metadata',
      'offline_access',
    ])
    expect(SUPPORTED_SCOPES).toContain('media:read')
    expect(SUPPORTED_SCOPES).toContain('media:write')
    expect(ADVERTISED_SCOPES).not.toContain('media:read')
  })
})

describe('advertisedScopes', () => {
  it('returns the base four when the media stack is absent', () => {
    expect(advertisedScopes({ mediaAvailable: false })).toEqual([
      'content:read',
      'content:write',
      'project:metadata',
      'offline_access',
    ])
  })

  it('adds media:read/media:write in canonical order when media is available', () => {
    expect(advertisedScopes({ mediaAvailable: true })).toEqual([
      'content:read',
      'content:write',
      'project:metadata',
      'media:read',
      'media:write',
      'offline_access',
    ])
  })
})

describe('normalizeScope', () => {
  it('defaults an absent scope to least privilege', () => {
    expect(normalizeScope(undefined)).toBe('content:read project:metadata')
    expect(normalizeScope('')).toBe('content:read project:metadata')
    expect(normalizeScope('   ')).toBe('content:read project:metadata')
  })

  it('canonicalizes order and deduplicates', () => {
    expect(normalizeScope('offline_access content:write content:read content:write'))
      .toBe('content:read content:write offline_access')
  })

  it('returns null for unknown members', () => {
    expect(normalizeScope('content:read openid')).toBeNull()
    expect(normalizeScope('admin')).toBeNull()
  })

  it('pads an offline_access-only request with the default scopes', () => {
    expect(normalizeScope('offline_access')).toBe('content:read project:metadata offline_access')
  })

  it('accepts reserved media scopes', () => {
    expect(normalizeScope('media:read content:read')).toBe('content:read media:read')
  })
})

describe('scopeIncludes', () => {
  it('does whole-token matching', () => {
    expect(scopeIncludes('content:read content:write', 'content:write')).toBe(true)
    expect(scopeIncludes('content:readx', 'content:read')).toBe(false)
    expect(scopeIncludes('content:read', 'offline_access')).toBe(false)
  })
})

describe('tool classification (derived from TOOL_ANNOTATIONS + TOOL_REQUIREMENTS)', () => {
  it('partitions the tool surface: metadata / read / write / media / lifecycle are disjoint', () => {
    const sets = [METADATA_TOOL_NAMES, READ_TOOL_NAMES, WRITE_TOOL_NAMES, MEDIA_TOOL_NAMES, STUDIO_OWNED_LIFECYCLE_TOOLS]
    for (let a = 0; a < sets.length; a++) {
      for (let b = a + 1; b < sets.length; b++) {
        for (const name of sets[a]!) {
          expect(sets[b]!.has(name), `${name} must appear in exactly one class`).toBe(false)
        }
      }
    }
  })

  it('pins the canonical members of each class', () => {
    expect([...METADATA_TOOL_NAMES]).toEqual(
      expect.arrayContaining(['contentrain_status', 'contentrain_describe', 'contentrain_describe_format']),
    )
    expect(READ_TOOL_NAMES.has('contentrain_content_list')).toBe(true)
    expect(WRITE_TOOL_NAMES.has('contentrain_content_save')).toBe(true)
    expect(WRITE_TOOL_NAMES.has('contentrain_model_delete')).toBe(true)
    expect(STUDIO_OWNED_LIFECYCLE_TOOLS.has('contentrain_merge')).toBe(true)
  })

  it('classifies the 1.10.0 media tools by facet requirement, split on readOnlyHint', () => {
    expect(MEDIA_READ_TOOL_NAMES).toEqual(new Set(['contentrain_media_list', 'contentrain_media_get']))
    expect(MEDIA_WRITE_TOOL_NAMES).toEqual(new Set(['contentrain_media_ingest', 'contentrain_media_update', 'contentrain_media_delete']))
  })

  it('media writes never enter the content-branch write set (no brain/auto-merge)', () => {
    for (const name of MEDIA_TOOL_NAMES) {
      expect(WRITE_TOOL_NAMES.has(name), `${name} must not trigger brain invalidation`).toBe(false)
      expect(READ_TOOL_NAMES.has(name), `${name} must not ride content:read`).toBe(false)
    }
  })
})

describe('toolsForScope', () => {
  it('project:metadata grants exactly the metadata tools', () => {
    expect(new Set(toolsForScope('project:metadata'))).toEqual(METADATA_TOOL_NAMES)
  })

  it('content:read grants the readOnly rest — not metadata, not writes', () => {
    const tools = new Set(toolsForScope('content:read'))
    expect(tools).toEqual(READ_TOOL_NAMES)
    expect(tools.has('contentrain_status')).toBe(false)
    expect(tools.has('contentrain_content_save')).toBe(false)
  })

  it('content:write adds the write set', () => {
    const tools = new Set(toolsForScope('content:read content:write'))
    for (const name of WRITE_TOOL_NAMES) expect(tools.has(name), name).toBe(true)
  })

  it('lifecycle tools are never granted, whatever the scope', () => {
    const everything = toolsForScope(SUPPORTED_SCOPES.join(' '))
    for (const name of STUDIO_OWNED_LIFECYCLE_TOOLS) {
      expect(everything).not.toContain(name)
    }
  })

  it('media scopes grant exactly the media tools; offline_access grants none', () => {
    expect(new Set(toolsForScope('media:read'))).toEqual(MEDIA_READ_TOOL_NAMES)
    expect(new Set(toolsForScope('media:read media:write'))).toEqual(MEDIA_TOOL_NAMES)
    expect(toolsForScope('offline_access')).toEqual([])
  })

  it('content scopes never leak media tools', () => {
    const contentTools = toolsForScope('content:read content:write project:metadata')
    for (const name of MEDIA_TOOL_NAMES) expect(contentTools).not.toContain(name)
  })

  it('scopeAllowsTool agrees with the derivation', () => {
    expect(scopeAllowsTool('content:read', 'contentrain_content_list')).toBe(true)
    expect(scopeAllowsTool('content:read', 'contentrain_content_save')).toBe(false)
  })
})

describe('scopeForTool (step-up challenge routing)', () => {
  it('routes each tool class to its scope', () => {
    expect(scopeForTool('contentrain_status')).toBe('project:metadata')
    expect(scopeForTool('contentrain_content_list')).toBe('content:read')
    expect(scopeForTool('contentrain_content_save')).toBe('content:write')
    expect(scopeForTool('contentrain_media_get')).toBe('media:read')
    expect(scopeForTool('contentrain_media_ingest')).toBe('media:write')
  })

  it('returns null for lifecycle/unknown tools — no step-up loop', () => {
    expect(scopeForTool('contentrain_merge')).toBeNull()
    expect(scopeForTool('not_a_tool')).toBeNull()
  })
})
