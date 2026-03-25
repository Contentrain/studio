import { describe, expect, it } from 'vitest'
import { useContent } from '../../../app/composables/useContent'

describe('useContent', () => {
  it('returns localized dictionary values', () => {
    const { t } = useContent()

    expect(t('auth.sign_in_title')).toBe('Sign in to your account')
    expect(t('common.menu')).toBe('Menu')
  })

  it('interpolates dictionary params', () => {
    const { t } = useContent()

    expect(t('branch.files_changed', { count: 3 })).toBe('3 files changed')
    expect(t('github.branch_label', { branch: 'main' })).toBe('Branch: main')
  })
})
