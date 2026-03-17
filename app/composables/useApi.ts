import type { FetchOptions } from 'ofetch'

/**
 * Authenticated API fetch — injects Supabase access token into requests.
 */
export function useApi() {
  const { getAccessToken } = useAuth()

  async function apiFetch<T>(url: string, options?: FetchOptions): Promise<T> {
    const token = getAccessToken()

    return $fetch<T>(url, {
      ...options,
      headers: {
        ...options?.headers as Record<string, string>,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
  }

  return { apiFetch }
}
