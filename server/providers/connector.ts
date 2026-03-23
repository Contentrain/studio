/**
 * Provider-agnostic connector interface.
 *
 * Connectors bridge external AI/design tools into Studio's content pipeline.
 * Interface lives in core (AGPL), implementations in ee/ (proprietary).
 *
 * Free connectors: URL fetch, file upload (core)
 * Pro connectors: Canva, Figma, Recraft (ee/)
 * Business connectors: Notion, Google Drive (ee/)
 *
 * Current impl: none yet (Phase 3)
 * Future impls: ee/connectors/canva.ts, ee/connectors/figma.ts, etc.
 */

export interface ConnectorItem {
  id: string
  title: string
  thumbnail?: string
  type: 'image' | 'document' | 'design' | 'data'
  meta?: Record<string, unknown>
}

export interface ConnectorContent {
  type: 'image' | 'text' | 'markdown' | 'html' | 'json'
  data: string | Record<string, unknown>
  assets?: Array<{ url: string, mime: string, filename?: string }>
}

export interface ConnectorProvider {
  /** Unique connector ID (e.g., 'canva', 'figma', 'url-fetch') */
  id: string

  /** Display name */
  name: string

  /** Icon class (annon icon set) */
  icon: string

  /** Auth method required */
  auth: 'oauth2' | 'api_key' | 'none'

  /** Feature flag key (checked via hasFeature) */
  featureKey: string

  /**
   * Start OAuth2 flow — returns redirect URL.
   * Only for auth: 'oauth2' connectors.
   */
  authorize?: (workspaceId: string, redirectUri: string) => Promise<{ redirectUrl: string }>

  /**
   * Browse items from the external service.
   * Returns a list of selectable items (designs, documents, images).
   */
  browse: (token: string, query?: string) => Promise<ConnectorItem[]>

  /**
   * Fetch full content for a selected item.
   * Returns normalized content ready for the chat context or content save.
   */
  fetch: (token: string, itemId: string) => Promise<ConnectorContent>
}
