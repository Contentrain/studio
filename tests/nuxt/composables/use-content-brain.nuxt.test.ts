import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The brain's cache key has to reach the server, or the browser downloads the
 * whole project on every load while already holding it in IndexedDB.
 *
 * Only the worker can read that key — it lives in IndexedDB — and `initBrain`
 * merely *posts* it a message. `sync` used to read `treeSha` in the same tick,
 * before the worker had answered, so the request went out with an empty query
 * string every single time. Measured on staging: two full page loads of a
 * project whose IndexedDB was populated, both sending no key, both answered
 * with the full 22 KB payload; the same project with the key supplied by hand
 * answered `delta: true` in 4.5 KB.
 *
 * So these tests are about ORDERING, and they drive the real composable
 * against a fake worker whose reply timing they control.
 */

/** How long the fake worker waits before answering `init`. */
const workerState = vi.hoisted(() => ({
  replyDelayMs: 0,
  reply: true as boolean,
  treeSha: null as string | null,
  snapshot: null as Record<string, unknown> | null,
  instances: 0,
}))

vi.mock('~/workers/content-brain.worker.ts?worker', () => ({
  default: class FakeContentBrainWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: { message: string }) => void) | null = null

    constructor() {
      workerState.instances++
    }

    postMessage(msg: { type: string }) {
      if (msg.type !== 'init' || !workerState.reply) return
      setTimeout(() => {
        this.onmessage?.({
          data: {
            type: 'ready',
            treeSha: workerState.treeSha,
            cached: workerState.treeSha !== null || workerState.snapshot !== null,
            snapshot: workerState.snapshot,
          },
        } as MessageEvent)
      }, workerState.replyDelayMs)
    }

    terminate() {}
  },
}))

const DIGEST = 'a'.repeat(64)

const FULL_RESPONSE = {
  treeSha: DIGEST,
  delta: false,
  config: { locales: { default: 'en', supported: ['en'] } },
  models: {},
  content: {},
  vocabulary: null,
  contentContext: null,
  contentSummary: {},
  schemaValidation: null,
}

/** The query string of the single `brain/sync` call a fetch stub recorded. */
function syncQuery(fetchMock: ReturnType<typeof vi.fn>): string {
  const url = String(fetchMock.mock.calls.at(-1)?.[0] ?? '')
  return url.split('?')[1] ?? ''
}

describe('useContentBrain sync', () => {
  beforeEach(() => {
    workerState.replyDelayMs = 0
    workerState.reply = true
    workerState.treeSha = null
    workerState.snapshot = null
    workerState.instances = 0
    useState('brain-tree-sha').value = null
    useState('brain-syncing').value = false
    useState('brain-ready').value = false
  })

  afterEach(async () => {
    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    useContentBrain().destroyBrain()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('sends the key the worker read out of IndexedDB, even though the worker answers late', async () => {
    // The regression. The worker answers a tick after `initBrain` returns —
    // exactly the window `sync` used to run inside.
    workerState.treeSha = DIGEST
    workerState.replyDelayMs = 5
    const fetchMock = vi.fn().mockResolvedValue({ ...FULL_RESPONSE, delta: true })
    vi.stubGlobal('$fetch', fetchMock)

    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    const brain = useContentBrain()
    brain.initBrain('project-1')
    await brain.sync('workspace-1', 'project-1')

    expect(syncQuery(fetchMock)).toBe(`treeSha=${DIGEST}`)
  })

  it('asks for a full sync when the browser has no key yet', async () => {
    workerState.treeSha = null
    const fetchMock = vi.fn().mockResolvedValue(FULL_RESPONSE)
    vi.stubGlobal('$fetch', fetchMock)

    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    const brain = useContentBrain()
    brain.initBrain('project-2')
    await brain.sync('workspace-1', 'project-2')

    expect(syncQuery(fetchMock)).toBe('')
  })

  it('declines a pre-hash key rather than sending one that earns a 431', async () => {
    // What a browser that used Studio before the hash still holds. Sending it
    // back is worse than sending nothing: on a sizeable project the request is
    // rejected before any handler runs, `sync` lands in its catch, and the
    // catch never writes a new key — so it would fail on every load, forever.
    workerState.treeSha = Array.from(
      { length: 54 },
      (_, i) => `.contentrain/content/m${i}/en.json:${'b'.repeat(40)}`,
    ).join('|')
    const fetchMock = vi.fn().mockResolvedValue(FULL_RESPONSE)
    vi.stubGlobal('$fetch', fetchMock)

    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    const brain = useContentBrain()
    brain.initBrain('project-3')
    await brain.sync('workspace-1', 'project-3')

    expect(syncQuery(fetchMock)).toBe('')
    // ...and the full response heals the browser: it now holds a real digest.
    expect(brain.treeSha.value).toBe(DIGEST)
  })

  it('gives up waiting rather than hanging when the worker never answers', async () => {
    // A missed cache costs one full sync. A gate that never opens holds
    // `syncing` true and costs the whole screen, so the wait is capped.
    vi.useFakeTimers()
    workerState.reply = false
    const fetchMock = vi.fn().mockResolvedValue(FULL_RESPONSE)
    vi.stubGlobal('$fetch', fetchMock)

    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    const brain = useContentBrain()
    brain.initBrain('project-4')
    const pending = brain.sync('workspace-1', 'project-4')

    await vi.advanceTimersByTimeAsync(3000)
    await pending

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(syncQuery(fetchMock)).toBe('')
    expect(brain.syncing.value).toBe(false)
  })
})

/** What a worker reads out of a populated IndexedDB: 12 models, as on staging. */
function cachedSnapshot(configDefault = 'en') {
  const models = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}`, kind: 'collection', domain: 'app', i18n: true, fields: {} }))
  return {
    exists: true,
    config: { locales: { default: configDefault, supported: [configDefault] } },
    models,
    content: Object.fromEntries(models.map(m => [m.id, { count: 3, locales: [configDefault], kind: 'collection' }])),
    vocabulary: null,
    contentContext: null,
    schemaValidation: { valid: true, warnings: [], healthScore: 97, modelCount: 12, validModels: 12, timestamp: 't' },
  }
}

/** The server's answer to a key that matches: nothing but the key. */
const EMPTY_DELTA = {
  treeSha: DIGEST,
  delta: true,
  config: null,
  models: null,
  content: null,
  vocabulary: null,
  contentContext: null,
  contentSummary: null,
}

describe('useContentBrain on a warm reload', () => {
  beforeEach(() => {
    workerState.replyDelayMs = 0
    workerState.reply = true
    workerState.treeSha = null
    workerState.snapshot = null
    useState('brain-tree-sha').value = null
    useState('brain-syncing').value = false
    useState('brain-ready').value = false
    useState('brain-config').value = null
    useState('brain-models').value = []
    useState('brain-schema-validation').value = null
  })

  afterEach(async () => {
    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    useContentBrain().destroyBrain()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows the cached project when the server answers with an empty delta', async () => {
    // The regression #322 exposed. Once the key reached the server, a reload of
    // an unchanged project got `{ treeSha, delta: true }` and nothing else —
    // and the screen only ever filled from a full answer, so a project with 12
    // models rendered as "Project needs setup".
    workerState.treeSha = DIGEST
    workerState.snapshot = cachedSnapshot()
    workerState.replyDelayMs = 5
    const fetchMock = vi.fn().mockResolvedValue(EMPTY_DELTA)
    vi.stubGlobal('$fetch', fetchMock)

    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    const brain = useContentBrain()
    brain.initBrain('project-warm')
    await brain.sync('workspace-1', 'project-warm')

    expect(syncQuery(fetchMock)).toBe(`treeSha=${DIGEST}`)
    expect(brain.hasContentrain.value).toBe(true)
    expect(brain.models.value).toHaveLength(12)
    expect(brain.contentSummary.value.m0).toEqual({ count: 3, locales: ['en'], kind: 'collection' })
    // The health report is cached too; an empty delta never brings one.
    expect(brain.schemaValidation.value?.healthScore).toBe(97)
  })

  it('keeps a full answer over a cached snapshot that arrives after it', async () => {
    // A worker slower than the wait cap: the sync goes out without a key and
    // the full answer lands first. The cache it then reports is older.
    vi.useFakeTimers()
    workerState.treeSha = DIGEST
    workerState.snapshot = cachedSnapshot('tr')
    workerState.replyDelayMs = 5000
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(FULL_RESPONSE))

    const { useContentBrain } = await import('../../../app/composables/useContentBrain')
    const brain = useContentBrain()
    brain.initBrain('project-slow')
    const pending = brain.sync('workspace-1', 'project-slow')
    await vi.advanceTimersByTimeAsync(3000)
    await pending
    await vi.advanceTimersByTimeAsync(2000)

    expect(brain.config.value?.locales?.default).toBe('en')
    expect(brain.models.value).toHaveLength(0)
  })
})
