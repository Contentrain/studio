import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import Tooltip from '../../../app/components/atoms/Tooltip.vue'

// The content is portalled to `document.body`, which outlives the wrapper —
// without this, one test reads the tooltip a previous one left behind.
afterEach(() => {
  document.body.innerHTML = ''
})

describe('Tooltip atom', () => {
  it('renders the trigger it was given instead of one of its own', async () => {
    // The point of the atom: `InfoTooltip` bakes in its own button and so can
    // only ever be an info icon; an action button has to stay an action button.
    const wrapper = await mountSuspended(Tooltip, {
      props: { text: 'Delete entry' },
      slots: { default: '<button type="button" aria-label="Delete entry">x</button>' },
    })

    const trigger = wrapper.find('button[aria-label="Delete entry"]')
    expect(trigger.exists()).toBe(true)
    // Radix merges its trigger onto the child rather than wrapping it, so the
    // button keeps whatever positioning its parent gave it.
    expect(trigger.attributes('data-state')).toBeDefined()
  })

  it('carries its own provider, so it works with no app-level one', async () => {
    // `TooltipRoot` throws without a provider — a component test mounting a
    // tooltip-bearing component on its own would fail if this were hoisted.
    await expect(mountSuspended(Tooltip, {
      props: { text: 'Standalone' },
      slots: { default: '<button type="button">x</button>' },
    })).resolves.toBeTruthy()
  })

  it('shows its text once opened', async () => {
    await mountSuspended(Tooltip, {
      props: { text: 'Attach entry to chat context', open: true },
      slots: { default: '<button type="button">x</button>' },
      attachTo: document.body,
    })
    await nextTick()

    expect(document.body.textContent).toContain('Attach entry to chat context')
  })

  it('opens on keyboard focus, not on hover alone', async () => {
    // An icon-only action button is reachable by tab, and its label has to be
    // reachable the same way.
    const wrapper = await mountSuspended(Tooltip, {
      props: { text: 'Show preview' },
      slots: { default: '<button type="button">x</button>' },
      attachTo: document.body,
    })

    await wrapper.find('button').trigger('focus')
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([true])

    await wrapper.find('button').trigger('blur')
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('drops the text padding in panel variant so a slot can fill it', async () => {
    await mountSuspended(Tooltip, {
      props: { variant: 'panel' as const, open: true },
      slots: { default: '<button type="button">x</button>', content: '<img alt="preview">' },
      attachTo: document.body,
    })
    await nextTick()

    const content = document.querySelector('[data-radix-popper-content-wrapper] > *')
    expect(content?.className).toContain('p-1')
    expect(content?.className).not.toContain('px-3')
    expect(document.querySelector('img[alt="preview"]')).not.toBeNull()
  })
})
