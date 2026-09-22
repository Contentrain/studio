import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyPlanInput } from '@contentrain/types'
import type { GitProvider } from '../../server/providers/git'
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

/** Nuxt server auto-imports the engine expects as globals. */
function stubEngineGlobals() {
  vi.stubGlobal('resolveModelPath', resolveModelPath)
  vi.stubGlobal('resolveContentPath', resolveContentPath)
  vi.stubGlobal('resolveMetaPath', resolveMetaPath)
  vi.stubGlobal('resolveContextPath', resolveContextPath)
  vi.stubGlobal('resolveConfigPath', resolveConfigPath)
  vi.stubGlobal('resolveVocabularyPath', resolveVocabularyPath)
  vi.stubGlobal('resolveModelsDir', resolveModelsDir)
  vi.stubGlobal('validateContent', validateContent)
}

/**
 * Concurrent writes must not revert each other (#285).
 *
 * Incident (customer project, 2026-09-07): an editor set an article to draft
 * at 12:39:36; it merged at 12:39:41. A colleague's unrelated save on the same
 * locale, committed at 12:39:43 ON TOP of that merge, rewrote the whole meta
 * file from what it had read before the merge and flipped the article back to
 * published. Every content write rewrites whole files from a read, and used to
 * fork from `contentrain` as it was at WRITE time, not at READ time.
 *
 * The fake repo below keeps a real commit graph and merges with
 * `git merge-file`, the same line-level 3-way merge GitHub runs.
 */

interface CommitNode { parents: string[], files: Map<string, string> }

function conflictError(): Error {
  return Object.assign(new Error('Merge conflict'), { status: 409 })
}

function mergeText(ours: string, base: string, theirs: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cas-merge-'))
  try {
    for (const [name, text] of [['ours', ours], ['base', base], ['theirs', theirs]] as const)
      writeFileSync(join(dir, name), text)
    try {
      execFileSync('git', ['merge-file', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { stdio: 'ignore' })
    }
    catch {
      throw conflictError()
    }
    return readFileSync(join(dir, 'ours'), 'utf8')
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function createFakeRepo(initial: Record<string, string>, opts: { cas: boolean }) {
  const commits = new Map<string, CommitNode>()
  const branches = new Map<string, string>()
  let seq = 0
  const commit = (files: Map<string, string>, parents: string[]) => {
    // Full 40-hex shas: MCP reads a 40-hex `base` as a commit, anything else as a branch name.
    const sha = (++seq).toString(16).padStart(40, '0')
    commits.set(sha, { parents, files })
    return sha
  }
  branches.set('contentrain', commit(new Map(Object.entries(initial)), []))
  branches.set('main', branches.get('contentrain')!)

  const resolve = (ref?: string) => {
    const sha = branches.get(ref ?? 'contentrain') ?? (commits.has(ref!) ? ref! : undefined)
    if (!sha) throw Object.assign(new Error(`ref ${ref} not found`), { status: 404 })
    return commits.get(sha)!
  }
  const ancestors = (sha: string) => {
    const seen = new Set<string>()
    const stack = [sha]
    while (stack.length) {
      const s = stack.pop()!
      if (seen.has(s)) continue
      seen.add(s)
      stack.push(...commits.get(s)!.parents)
    }
    return seen
  }
  const mergeBase = (a: string, b: string) => {
    const ofA = ancestors(a)
    // Breadth-first from b: the nearest ancestor of b that a also reaches.
    const queue = [b]
    const seen = new Set<string>()
    while (queue.length) {
      const s = queue.shift()!
      if (ofA.has(s)) return s
      if (seen.has(s)) continue
      seen.add(s)
      queue.push(...commits.get(s)!.parents)
    }
    throw new Error('no merge base')
  }

  const git = {
    readFile: vi.fn(async (path: string, ref?: string) => {
      const content = resolve(ref).files.get(path)
      if (content === undefined) throw Object.assign(new Error(`Not Found: ${path}`), { status: 404 })
      return content
    }),
    listDirectory: vi.fn(async (path: string, ref?: string) => {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      for (const p of resolve(ref).files.keys()) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!)
      }
      return [...names]
    }),
    fileExists: vi.fn(async (path: string, ref?: string) => resolve(ref).files.has(path)),
    listBranches: vi.fn(async () => [...branches].map(([name, sha]) => ({ name, sha, protected: false }))),
    getDefaultBranch: vi.fn(async () => 'main'),
    createBranch: vi.fn(async (name: string, from = 'main') => { branches.set(name, branches.get(from)!) }),
    deleteBranch: vi.fn(async (name: string) => { branches.delete(name) }),
    // GitHub compare `base...branch`: what the branch changed since it forked.
    getBranchDiff: vi.fn(async (branch: string, base = 'contentrain') => {
      const head = branches.get(branch)!
      const from = commits.get(mergeBase(head, branches.get(base)!))!.files
      const to = commits.get(head)!.files
      return [...new Set([...from.keys(), ...to.keys()])]
        .filter(path => from.get(path) !== to.get(path))
        .map(path => ({
          path,
          status: !from.has(path) ? 'added' : !to.has(path) ? 'removed' : 'modified',
          before: from.get(path) ?? null,
          after: to.get(path) ?? null,
        }))
    }),
    applyPlan: vi.fn(async (input: ApplyPlanInput) => {
      // MCP GitHubProvider semantics (3.6.0): a full-sha `base` is the parent
      // of a new branch, and an existing branch must sit exactly on it — else
      // 409, nothing written. A branch-name `base` forks from that branch's
      // head at the moment of writing; an existing branch's head is the parent.
      const head = branches.get(input.branch)
      let parent: string
      if (input.base && /^[0-9a-f]{40}$/i.test(input.base)) {
        if (head !== undefined && head !== input.base)
          throw Object.assign(new Error(`Branch ${input.branch} is at ${head}, not at the base ${input.base}`), { status: 409 })
        parent = input.base
      }
      else {
        parent = head ?? branches.get(input.base ?? 'contentrain')!
      }
      const files = new Map(commits.get(parent)!.files)
      for (const change of input.changes) {
        if (change.content === null) files.delete(change.path)
        else files.set(change.path, change.content)
      }
      const sha = commit(files, [parent])
      branches.set(input.branch, sha)
      return { sha, message: input.message, author: input.author, timestamp: '' }
    }),
    mergeBranch: vi.fn(async (branch: string, into: string) => {
      const head = branches.get(branch)!
      const target = branches.get(into)!
      if (ancestors(target).has(head)) return { merged: true, sha: target, pullRequestUrl: null }
      const base = commits.get(mergeBase(head, target))!.files
      const ours = commits.get(target)!.files
      const theirs = commits.get(head)!.files
      const files = new Map<string, string>()
      for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
        const b = base.get(path)
        const o = ours.get(path)
        const t = theirs.get(path)
        let merged: string | undefined
        if (o === t) merged = o
        else if (b === t) merged = o
        else if (b === o) merged = t
        else if (o === undefined || t === undefined || b === undefined) throw conflictError()
        else merged = mergeText(o, b, t)
        if (merged !== undefined) files.set(path, merged)
      }
      const sha = commit(files, [target, head])
      branches.set(into, sha)
      return { merged: true, sha, pullRequestUrl: null }
    }),
    ...(opts.cas
      ? {
          getBranchSha: vi.fn(async (branch: string) => branches.get(branch) ?? null),
        }
      : {}),
  }

  return {
    git: git as unknown as GitProvider & typeof git,
    head: (branch = 'contentrain') => resolve(branch).files,
    meta: (branch = 'contentrain') => JSON.parse(resolve(branch).files.get('.contentrain/meta/articles/tr.json')!) as Record<string, { status: string }>,
    content: (branch = 'contentrain') => JSON.parse(resolve(branch).files.get('.contentrain/content/blog/articles/tr.json')!) as Record<string, Record<string, unknown>>,
  }
}

// ── fixture: a `tr`-default project with one articles collection ──

const IDS = ['a1', 'a2', 'a3', 'a4'] as const

function articlesRepo(opts: { cas: boolean }) {
  const meta: Record<string, unknown> = {}
  const content: Record<string, unknown> = {}
  for (const id of IDS) {
    meta[id] = { source: 'agent', status: 'published', updated_by: 'contentrain-mcp' }
    content[id] = { title: `Title ${id}` }
  }
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`
  return createFakeRepo({
    '.contentrain/config.json': json({ version: 1, stack: 'nuxt', workflow: 'auto-merge', domains: ['blog'], locales: { default: 'tr', supported: ['tr'] } }),
    '.contentrain/models/articles.json': json({ id: 'articles', name: 'Articles', kind: 'collection', domain: 'blog', i18n: true, fields: { title: { type: 'string' } } }),
    '.contentrain/content/blog/articles/tr.json': json(content),
    '.contentrain/meta/articles/tr.json': json(meta),
  }, opts)
}

describe('content writes fork from the commit they read (#285)', () => {
  beforeAll(async () => {
    await import('../../server/utils/content-engine')
  }, 60_000)

  beforeEach(stubEngineGlobals)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function engineFor(git: GitProvider) {
    const { createContentEngine } = await import('../../server/utils/content-engine')
    // No projectId: skips branch-health, schedules and deploy hooks.
    return createContentEngine({ git, contentRoot: '' })
  }

  it('C09 regression: a save that read before a status change landed does not revert it', async () => {
    const repo = articlesRepo({ cas: true })
    // B's commit is held until A has landed, so every read B makes provably
    // happens before A's change is on `contentrain` — the incident's ordering.
    const bMayWrite = Promise.withResolvers<undefined>()
    const bReachedWrite = Promise.withResolvers<undefined>()
    const gitForB = {
      ...repo.git,
      applyPlan: async (input: ApplyPlanInput) => {
        bReachedWrite.resolve(undefined)
        await bMayWrite.promise
        return repo.git.applyPlan(input)
      },
    } as GitProvider
    const editorA = await engineFor(repo.git)
    const editorB = await engineFor(gitForB)

    const bSave = editorB.saveContent('articles', 'tr', { a4: { title: 'Updated a4' } }, 'b@example.com')
    await bReachedWrite.promise

    // A drafts a3 and lands it while B's save is between its reads and its commit.
    const aWrite = await editorA.updateEntryStatus('articles', 'tr', ['a3'], 'draft', 'a@example.com')
    await editorA.mergeToContentrain(aWrite.branch)
    expect(repo.meta().a3!.status).toBe('draft')

    bMayWrite.resolve(undefined)
    const bWrite = await bSave
    const landed = await editorB.mergeToContentrain(bWrite.branch)

    expect(landed.merged).toBe(true)
    expect(repo.meta().a3!.status).toBe('draft') // A's change survived
    expect(repo.content().a4!.title).toBe('Updated a4') // B's change landed
  })

  it('two concurrent saves on different entries of the same locale file both survive', async () => {
    const repo = articlesRepo({ cas: true })
    const a = await engineFor(repo.git)
    const b = await engineFor(repo.git)

    // Both read the same head, then write.
    const [aWrite, bWrite] = await Promise.all([
      a.saveContent('articles', 'tr', { a1: { title: 'A edits a1' } }, 'a@example.com'),
      b.saveContent('articles', 'tr', { a4: { title: 'B edits a4' } }, 'b@example.com'),
    ])
    await a.mergeToContentrain(aWrite.branch)
    await b.mergeToContentrain(bWrite.branch)

    expect(repo.content().a1!.title).toBe('A edits a1')
    expect(repo.content().a4!.title).toBe('B edits a4')
  })

  it('without the CAS primitives the old fork-at-write-time behaviour is kept', async () => {
    const repo = articlesRepo({ cas: false })
    const engine = await engineFor(repo.git)

    const write = await engine.saveContent('articles', 'tr', { a1: { title: 'x' } }, 'a@example.com')

    expect(write.branch).toMatch(/^cr\/content\/articles\/tr\//)
    expect(repo.git.applyPlan.mock.calls[0]![0].base).toBe('contentrain')
  })

  it('commits on the commit the reads came from', async () => {
    const repo = articlesRepo({ cas: true })
    const engine = await engineFor(repo.git)
    const headAtRead = await repo.git.getBranchSha!('contentrain')

    await engine.saveContent('articles', 'tr', { a1: { title: 'x' } }, 'a@example.com')

    // The snapshot sha is the `base` itself — MCP forks the branch there.
    expect(repo.git.applyPlan.mock.calls[0]![0].base).toBe(headAtRead)
    // Every read of the write was pinned to that commit, not to the branch name.
    const refs = repo.git.readFile.mock.calls.map(call => call[1])
    expect(refs.length).toBeGreaterThan(0)
    expect(new Set(refs)).toEqual(new Set([headAtRead]))
  })

  it('redoes a write once when its branch is not at the base it was built on', async () => {
    const repo = articlesRepo({ cas: true })
    const engine = await engineFor(repo.git)
    const stale = Object.assign(new Error('Branch is at another commit'), { status: 409 })
    const applyPlan = repo.git.applyPlan.getMockImplementation()!
    repo.git.applyPlan.mockImplementationOnce(async () => {
      throw stale
    })

    const write = await engine.saveContent('articles', 'tr', { a1: { title: 'x' } }, 'a@example.com')
    repo.git.applyPlan.mockImplementation(applyPlan)

    expect(repo.git.applyPlan).toHaveBeenCalledTimes(2)
    expect(repo.git.applyPlan.mock.calls[1]![0].branch).toBe(write.branch)
    expect(repo.content(write.branch).a1!.title).toBe('x')
  })

  it('returns a second stale-base refusal instead of retrying forever', async () => {
    const repo = articlesRepo({ cas: true })
    const engine = await engineFor(repo.git)
    const stale = Object.assign(new Error('Branch is at another commit'), { status: 409 })
    repo.git.applyPlan.mockRejectedValueOnce(stale).mockRejectedValueOnce(stale)

    await expect(engine.saveContent('articles', 'tr', { a1: { title: 'x' } }, 'a@example.com')).rejects.toThrow('Branch is at another commit')
    expect(repo.git.applyPlan).toHaveBeenCalledTimes(2)
  })
})

describe('a conflicting auto-merge is redone once, never forced (#285)', () => {
  beforeAll(async () => {
    await import('../../server/utils/content-engine')
  }, 60_000)

  beforeEach(stubEngineGlobals)

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function engineFor(git: GitProvider) {
    const { createContentEngine } = await import('../../server/utils/content-engine')
    return createContentEngine({ git, contentRoot: '' })
  }

  it('redoes a write whose lines a concurrent write changed, on top of that write', async () => {
    const repo = articlesRepo({ cas: true })
    const a = await engineFor(repo.git)
    const b = await engineFor(repo.git)

    // Same entry, same field: a genuine line conflict.
    const [aWrite, bWrite] = await Promise.all([
      a.saveContent('articles', 'tr', { a2: { title: 'A title' } }, 'a@example.com'),
      b.saveContent('articles', 'tr', { a2: { title: 'B title' } }, 'b@example.com'),
    ])
    await a.mergeToContentrain(aWrite.branch)
    const landed = await b.mergeToContentrain(bWrite.branch)

    expect(landed).toMatchObject({ merged: true, redone: true })
    expect(landed.branch).not.toBe(bWrite.branch) // the redo landed under a new branch
    expect(repo.content().a2!.title).toBe('B title') // last writer wins, explicitly
  })

  it('reports a conflict that survives the redo instead of forcing it', async () => {
    const repo = articlesRepo({ cas: true })
    const engine = await engineFor(repo.git)
    const write = await engine.saveContent('articles', 'tr', { a1: { title: 'x' } }, 'a@example.com')
    repo.git.mergeBranch.mockRejectedValue(Object.assign(new Error('Merge conflict'), { status: 409 }))
    repo.git.mergeBranch.mockClear()
    repo.git.applyPlan.mockClear()

    const landed = await engine.mergeToContentrain(write.branch)

    expect(landed).toMatchObject({ merged: false, conflict: true, redone: true })
    // Exactly one redo: one more commit, one more merge attempt — then stop.
    expect(repo.git.applyPlan).toHaveBeenCalledTimes(1)
    expect(repo.git.mergeBranch).toHaveBeenCalledTimes(2)
  })

  it('does not redo a branch this engine did not write (a person merging a held review)', async () => {
    const repo = articlesRepo({ cas: true })
    const writer = await engineFor(repo.git)
    const write = await writer.saveContent('articles', 'tr', { a1: { title: 'x' } }, 'a@example.com')
    const reviewer = await engineFor(repo.git)
    repo.git.mergeBranch.mockRejectedValue(Object.assign(new Error('Merge conflict'), { status: 409 }))

    const landed = await reviewer.mergeBranch(write.branch)

    expect(landed).toMatchObject({ merged: false, conflict: true })
    expect(repo.git.applyPlan).toHaveBeenCalledTimes(1)
  })
})
