import { beforeEach, describe, expect, it } from 'vitest'
import { useToast } from '../../../app/composables/useToast'

describe('useToast', () => {
  beforeEach(() => {
    const toast = useToast()
    for (const item of [...toast.toasts.value]) {
      toast.dismiss(item.id)
    }
  })

  it('adds and removes toast notifications', () => {
    const toast = useToast()

    toast.success('Saved', 'Entry updated')
    toast.error('Failed')

    expect(toast.toasts.value).toHaveLength(2)
    expect(toast.toasts.value[0]).toMatchObject({
      variant: 'success',
      title: 'Saved',
      description: 'Entry updated',
    })

    toast.dismiss(toast.toasts.value[0]!.id)
    expect(toast.toasts.value).toHaveLength(1)
    expect(toast.toasts.value[0]?.variant).toBe('error')
  })
})
