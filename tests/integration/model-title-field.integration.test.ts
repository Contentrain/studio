import { describe, expect, it, vi } from 'vitest'
import { withTestServer } from '../helpers/http'
import { getPlanLimit, hasFeature } from '../../server/utils/license'
import { createContentEngine } from '../../server/utils/content-engine'
import { validateContent } from '../../server/utils/content-validation'
import {
  resolveConfigPath,
  resolveContentPath,
  resolveContextPath,
  resolveMetaPath,
  resolveModelPath,
  resolveModelsDir,
  resolveVocabularyPath,
} from '../../server/utils/content-paths'

async function loadModelPatchHandler() {
  return (await import('../../server/api/workspaces/[workspaceId]/projects/[projectId]/models/[modelId].patch')).default
}

const MODEL = {
  id: 'integration-groups',
  name: 'Integration Groups',
  kind: 'collection' as const,
  domain: 'marketing',
  i18n: true,
  title_field: 'icon',
  fields: {
    description: { type: 'text' },
    icon: { type: 'icon' },
    title: { type: 'string', required: true },
  },
}

/**
 * `plan` decides the forms gate. The point of most of these cases is that the
 * title field must not be behind it.
 */
function stubRoute(options: { plan?: string, model?: unknown, saveModel?: ReturnType<typeof vi.fn> } = {}) {
  const saveModel = options.saveModel ?? vi.fn().mockResolvedValue({
    branch: 'cr/model/integration-groups/1',
    commit: { sha: 'sha-1', message: '', author: {}, timestamp: '' },
    diff: [],
    validation: { valid: true, errors: [] },
  })

  const params: Record<string, string> = {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    modelId: 'integration-groups',
  }
  vi.stubGlobal('getRouterParam', vi.fn((_e: unknown, name: string) => params[name]))
  vi.stubGlobal('requireAuth', vi.fn().mockReturnValue({
    user: { id: 'user-1', email: 'owner@example.com' },
    accessToken: 'token-1',
  }))
  vi.stubGlobal('useDatabaseProvider', vi.fn().mockReturnValue({
    requireWorkspaceRole: vi.fn().mockResolvedValue('owner'),
  }))
  vi.stubGlobal('resolveProjectContext', vi.fn().mockResolvedValue({
    git: {},
    contentRoot: '',
    workspace: { id: 'workspace-1', plan: options.plan ?? 'free' },
  }))
  vi.stubGlobal('getWorkspacePlan', vi.fn(() => options.plan ?? 'free'))
  // Real gates against the stubbed plan — the route reaches them through Nitro
  // auto-import, which this harness resolves via globals. Stubbing them away
  // would make "not behind the forms gate" prove nothing.
  vi.stubGlobal('hasFeature', hasFeature)
  vi.stubGlobal('getPlanLimit', getPlanLimit)
  vi.stubGlobal('getOrBuildBrainCache', vi.fn().mockResolvedValue({
    models: new Map([['integration-groups', options.model ?? MODEL]]),
  }))
  vi.stubGlobal('createContentEngine', vi.fn(() => ({
    saveModel,
    mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null }),
  })))
  vi.stubGlobal('invalidateBrainCache', vi.fn())
  vi.stubGlobal('emitWebhookEvent', vi.fn().mockResolvedValue(undefined))

  return { saveModel }
}

async function patch(body: unknown) {
  return withTestServer({
    routes: [{
      path: '/api/workspaces/workspace-1/projects/project-1/models/integration-groups',
      handler: await loadModelPatchHandler(),
    }],
  }, async ({ request }) => {
    const response = await request('/api/workspaces/workspace-1/projects/project-1/models/integration-groups', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  })
}

describe('model title_field PATCH', () => {
  it('writes the chosen field into the model definition', async () => {
    const { saveModel } = stubRoute()

    const res = await patch({ titleField: 'title' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ saved: true, titleField: 'title' })
    const saved = saveModel.mock.calls[0]?.[0] as { title_field?: string, fields?: unknown }
    expect(saved.title_field).toBe('title')
    // The rest of the definition rides along untouched.
    expect(saved.fields).toEqual(MODEL.fields)
  })

  it('is NOT behind the forms gate — a free plan can still fix its titles', async () => {
    // The header selector is a display preference, not a forms feature. Gating
    // it would leave the listing unreadable on every plan without forms.
    const { saveModel } = stubRoute({ plan: 'free' })

    const res = await patch({ titleField: 'title' })

    expect(res.status).toBe(200)
    expect(saveModel).toHaveBeenCalled()
  })

  it('refuses a field the model does not declare', async () => {
    stubRoute()
    const res = await patch({ titleField: 'nope' })
    expect(res.status).toBe(400)
  })

  it('refuses a field that cannot render as text', async () => {
    // `icon` stores a string, which is exactly why the rule is by meaning.
    stubRoute()
    const res = await patch({ titleField: 'icon' })
    expect(res.status).toBe(400)
  })

  // A page singleton built from sections: its title is a section's heading.
  it('accepts a dotted path one level into an object field', async () => {
    const page = {
      ...MODEL,
      kind: 'singleton' as const,
      title_field: 'hero.heading',
      fields: {
        hero: { type: 'object', required: true, fields: { heading: { type: 'string', required: true }, image: { type: 'image' } } },
        work: { type: 'array', items: { type: 'object', fields: { caption: { type: 'string' } } } },
      },
    }
    const { saveModel } = stubRoute({ model: page })

    const res = await patch({ titleField: 'hero.heading' })

    expect(res.status).toBe(200)
    expect((saveModel.mock.calls[0]?.[0] as { title_field?: string }).title_field).toBe('hero.heading')
    for (const bad of ['hero.image', 'hero.title', 'work.caption', 'hero.heading.text'])
      expect((await patch({ titleField: bad })).status, bad).toBe(400)
  })

  // Through the real engine: saveModel runs its own title check, and the model is read back from what it wrote.
  it('saves a dotted title_field through the content engine and reads it back', async () => {
    const page = {
      ...MODEL,
      kind: 'singleton' as const,
      title_field: 'title',
      fields: {
        title: { type: 'string' },
        hero: { type: 'object', fields: { heading: { type: 'string', required: true } } },
      },
    }
    const files = new Map<string, string>([
      ['.contentrain/config.json', JSON.stringify({ version: 1, stack: 'nuxt', workflow: 'auto-merge', locales: { default: 'en', supported: ['en'] }, domains: ['marketing'] })],
      ['.contentrain/models/integration-groups.json', JSON.stringify(page)],
    ])
    const commit = { sha: 'sha-1', message: '', author: { name: 'bot', email: 'bot@example.com' }, timestamp: '' }
    const git = {
      readFile: vi.fn(async (path: string) => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`Missing file: ${path}`)
        return text
      }),
      listDirectory: vi.fn().mockResolvedValue([]),
      fileExists: vi.fn(async (path: string) => files.has(path)),
      listBranches: vi.fn().mockResolvedValue([{ name: 'contentrain', sha: 'abc', protected: false }]),
      createBranch: vi.fn(),
      getBranchDiff: vi.fn().mockResolvedValue([]),
      getDefaultBranch: vi.fn().mockResolvedValue('main'),
      mergeBranch: vi.fn().mockResolvedValue({ merged: true, sha: 'merge-sha', pullRequestUrl: null }),
      applyPlan: vi.fn(async ({ changes }: { changes: Array<{ path: string, content: string | null }> }) => {
        for (const change of changes) if (change.content !== null) files.set(change.path, change.content)
        return commit
      }),
      commitFiles: vi.fn().mockResolvedValue(commit),
    }
    for (const [name, fn] of Object.entries({ resolveConfigPath, resolveContentPath, resolveContextPath, resolveMetaPath, resolveModelPath, resolveModelsDir, resolveVocabularyPath, validateContent }))
      vi.stubGlobal(name, fn)
    const engine = createContentEngine({ git: git as never, contentRoot: '' })
    const saveModel = vi.fn((model: never, email: string) => engine.saveModel(model, email))
    stubRoute({ model: page, saveModel })

    const res = await patch({ titleField: 'hero.heading' })

    expect(res.status).toBe(200)
    const written = [...files].find(([path]) => path.endsWith('/models/integration-groups.json'))!
    expect(JSON.parse(written[1]).title_field).toBe('hero.heading')
  })

  it('allows only `key` on a dictionary, which declares no fields', async () => {
    stubRoute({ model: { ...MODEL, kind: 'dictionary', fields: {} } })

    expect((await patch({ titleField: 'title' })).status).toBe(400)
    expect((await patch({ titleField: 'key' })).status).toBe(200)
  })

  it('still rejects a body carrying neither a form nor a title field', async () => {
    stubRoute()
    const res = await patch({})
    expect(res.status).toBe(400)
  })

  it('keeps the forms gate for form updates', async () => {
    // Splitting the handler in two must not have opened the other branch.
    stubRoute({ plan: 'free' })
    const res = await patch({ form: { enabled: true, exposedFields: ['title'] } })
    expect(res.status).toBe(403)
  })
})
