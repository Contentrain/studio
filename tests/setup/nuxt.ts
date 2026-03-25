import { afterEach, vi } from 'vitest'
import { config } from '@vue/test-utils'

config.global.stubs = {
  ClientOnly: {
    template: '<div><slot /></div>',
  },
  NuxtImg: {
    props: ['src', 'alt'],
    template: '<img :src="src" :alt="alt">',
  },
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})
