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
import {
  useAIProvider,
  useAuthProvider,
  useCDNProvider,
  useDatabaseProvider,
  useEmailProvider,
  useGitAppProvider,
  useGitProvider,
  useMediaProvider,
} from '../../server/utils/providers'
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
  vi.stubGlobal('useAIProvider', useAIProvider)
  vi.stubGlobal('useAuthProvider', useAuthProvider)
  vi.stubGlobal('useCDNProvider', useCDNProvider)
  vi.stubGlobal('useDatabaseProvider', () => {
    const actual = useDatabaseProvider()
    const globals = globalThis as typeof globalThis & {
      useSupabaseUserClient?: (accessToken: string) => unknown
      useSupabaseAdmin?: () => unknown
    }
    const userClient = globals.useSupabaseUserClient
    const adminClient = globals.useSupabaseAdmin

    return {
      ...actual,
      getUserClient: (accessToken: string) => {
        if (typeof userClient === 'function')
          return userClient(accessToken)
        return actual.getUserClient(accessToken)
      },
      getAdminClient: () => {
        if (typeof adminClient === 'function')
          return adminClient()
        return actual.getAdminClient()
      },
    }
  })
  vi.stubGlobal('useEmailProvider', useEmailProvider)
  vi.stubGlobal('useGitAppProvider', useGitAppProvider)
  vi.stubGlobal('useGitProvider', useGitProvider)
  vi.stubGlobal('useMediaProvider', useMediaProvider)

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
