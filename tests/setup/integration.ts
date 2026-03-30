import {
  appendHeader,
  createError,
  defineEventHandler,
  getHeader,
  readRawBody,
  getRequestPath,
  getQuery,
  getRequestURL,
  getRouterParam,
  readBody,
  sendRedirect,
  setResponseHeader,
  setResponseStatus,
  useSession,
} from 'h3'
import { afterEach, beforeEach, vi } from 'vitest'
import { clearServerSession, getServerSession, setAuthState, setServerSession, validateAuthState } from '../../server/utils/session'
import { requireAuth } from '../../server/utils/auth'

const runtimeConfig = {
  sessionSecret: 'test-session-secret-32-characters-min',
  public: {
    siteUrl: 'http://localhost:3000',
  },
  github: {
    appId: 'test-app-id',
    privateKey: Buffer.from('test-private-key', 'utf-8').toString('base64'),
  },
  anthropic: {
    apiKey: 'studio-test-key',
  },
  cdn: {},
}

beforeEach(() => {
  vi.resetModules()

  vi.stubGlobal('appendHeader', appendHeader)
  vi.stubGlobal('clearServerSession', clearServerSession)
  vi.stubGlobal('createError', createError)
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('getHeader', getHeader)
  vi.stubGlobal('getRequestPath', getRequestPath)
  vi.stubGlobal('getQuery', getQuery)
  vi.stubGlobal('getRequestURL', getRequestURL)
  vi.stubGlobal('getRouterParam', getRouterParam)
  vi.stubGlobal('getServerSession', getServerSession)
  vi.stubGlobal('readBody', readBody)
  vi.stubGlobal('readRawBody', readRawBody)
  vi.stubGlobal('requireAuth', requireAuth)
  vi.stubGlobal('sendRedirect', sendRedirect)
  vi.stubGlobal('setAuthState', setAuthState)
  vi.stubGlobal('setResponseHeader', setResponseHeader)
  vi.stubGlobal('setResponseStatus', setResponseStatus)
  vi.stubGlobal('setServerSession', setServerSession)
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
  vi.stubGlobal('useSession', useSession)
  vi.stubGlobal('validateAuthState', validateAuthState)
  vi.stubGlobal('errorMessage', (key: string) => key)
  vi.stubGlobal('agentMessage', (key: string) => key)
  vi.stubGlobal('agentPrompt', (key: string) => key)
  vi.stubGlobal('emptyAffected', () => ({ models: [], content: [], branches: [], vocabulary: false, config: false }))
  vi.stubGlobal('mergeAffected', (a: unknown) => a)

  vi.stubGlobal('checkRateLimit', vi.fn().mockReturnValue({
    allowed: true,
    retryAfterMs: 0,
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})
