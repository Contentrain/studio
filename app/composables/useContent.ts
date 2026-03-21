import { dictionary } from '#contentrain'

/**
 * Access UI strings from Contentrain dictionary via @contentrain/query SDK.
 * Usage: const { t } = useContent()
 *        t('auth.sign_in_title') => "Sign in to your account"
 */
export function useContent() {
  const locale = ref('en')

  const strings = computed(() =>
    dictionary('ui-strings').locale(locale.value).get(),
  )

  function t(key: string, params?: Record<string, string | number>): string {
    let value = strings.value?.[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replaceAll(`{${k}}`, String(v))
      }
    }
    return value
  }

  return { t, locale }
}
