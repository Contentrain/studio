import { createError } from 'h3'
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
  // The real h3 factory, so a unit test can assert the status code a server
  // util chose, not only its message.
  if (typeof globalThis.createError === 'undefined')
    vi.stubGlobal('createError', createError)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
