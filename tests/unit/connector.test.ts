import { describe, expect, expectTypeOf, it } from 'vitest'
import type { ConnectorContent, ConnectorItem, ConnectorProvider } from '../../server/providers/connector'

describe('connector provider contract', () => {
  it('supports a typed provider implementation shape', async () => {
    const provider: ConnectorProvider = {
      id: 'url-fetch',
      name: 'URL Fetch',
      icon: 'icon-[annon--link-1]',
      auth: 'none',
      featureKey: 'connector.url_fetch',
      browse: async () => [{ id: '1', title: 'Homepage', type: 'document' }],
      fetch: async () => ({ type: 'html', data: '<h1>Hello</h1>' }),
    }

    const items = await provider.browse('')
    const content = await provider.fetch('', '1')

    expect(items[0]).toMatchObject({ id: '1', type: 'document' })
    expect(content).toMatchObject({ type: 'html' })
  })

  it('exports stable TypeScript contracts for items and content', () => {
    expectTypeOf<ConnectorItem['type']>().toEqualTypeOf<'image' | 'document' | 'design' | 'data'>()
    expectTypeOf<ConnectorContent['type']>().toEqualTypeOf<'image' | 'text' | 'markdown' | 'html' | 'json'>()
  })
})
