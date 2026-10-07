import { describe, expect, it } from 'vitest'
import { getCommands } from '../../app/utils/command-registry'

const ctx = { isDark: false, isInProject: true, currentModelId: 'x', allowedModelIds: [] }

describe('command registry — keys and settings entries', () => {
  const commands = getCommands(ctx)
  const byId = (id: string) => commands.find(c => c.id === id)

  it('the workspace AI entry opens the AI tab', () => {
    expect(byId('cmd:ws-ai-keys')).toMatchObject({ labelKey: 'settings.ai_tab', action: 'ws-ai' })
  })

  it('MCP keys and the old Conversation API entry both open the project API keys tab', () => {
    expect(byId('cmd:mcp-keys')).toMatchObject({ labelKey: 'mcp_cloud.section_title', action: 'open-api-keys', scope: 'project' })
    expect(byId('cmd:mcp-keys')!.keywords).toEqual(expect.arrayContaining(['mcp', 'cursor', 'agent']))
    expect(byId('cmd:conversation-keys')).toMatchObject({ labelKey: 'project_settings.api_keys_tab', action: 'open-api-keys' })
  })

  it('project entries use dictionary keys, not hardcoded English labels', () => {
    for (const id of ['cmd:media', 'cmd:health', 'cmd:project-settings', 'cmd:conversation-keys', 'cmd:mcp-keys']) {
      expect(byId(id)!.label, id).toBeUndefined()
      expect(byId(id)!.labelKey, id).toBeTruthy()
    }
  })
})
