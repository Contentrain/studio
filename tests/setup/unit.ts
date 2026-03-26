import { afterEach, beforeEach, vi } from 'vitest'

// Stub content-strings functions — return key as-is so tests can match on keys
// Individual tests can override with vi.stubGlobal if they need specific behavior
beforeEach(() => {
  if (typeof globalThis.errorMessage === 'undefined')
    vi.stubGlobal('errorMessage', (key: string) => key)
  if (typeof globalThis.agentMessage === 'undefined')
    vi.stubGlobal('agentMessage', (key: string) => key)
  if (typeof globalThis.agentPrompt === 'undefined')
    vi.stubGlobal('agentPrompt', (key: string) => key)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
