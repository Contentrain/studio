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

  function t(key: string): string {
    return strings.value?.[key] ?? key
  }

  return { t, locale }
}
