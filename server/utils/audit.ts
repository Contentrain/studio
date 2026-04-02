/**
 * GDPR audit logging — route registry and types.
 *
 * Maps DELETE API routes to their entity type and snapshot function.
 * Used by the audit middleware (04.audit.ts) to automatically capture
 * a record snapshot before deletion, and by the audit-writer plugin
 * to persist the audit log after a successful response.
 */
import type { H3Event } from 'h3'
import type { DatabaseProvider, DatabaseRow } from '../providers/database'

// ─── Types ───

export interface AuditSnapshot {
  entity: string
  action: string
  recordId: string
  workspaceId: string | null
  snapshot: DatabaseRow | null
  actorId: string
  sourceIp: string | null
  userAgent: string | null
  timestamp: number
}

interface AuditableRoute {
  pattern: RegExp
  entity: string
  action: string
  extractIds: (matches: string[]) => { recordId: string, workspaceId: string | null }
  snapshot: (db: DatabaseProvider, ids: { recordId: string, workspaceId: string | null }) => Promise<DatabaseRow | null>
}

// ─── Route Registry ───
// Order matters: more specific patterns first.
// extractIds receives guaranteed match groups — pattern only matches when all groups exist.

const AUDITABLE_ROUTES: AuditableRoute[] = [
  // Form submission (contains external user PII — highest priority)
  {
    pattern: /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/forms\/([^/]+)\/submissions\/([^/]+)$/,
    entity: 'form_submission',
    action: 'delete_form_submission',
    extractIds: m => ({ workspaceId: m[1]!, recordId: m[4]! }),
    snapshot: (db, ids) => db.getFormSubmission(ids.recordId),
  },
  // Media asset
  {
    pattern: /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/media\/([^/]+)$/,
    entity: 'media_asset',
    action: 'delete_media_asset',
    extractIds: m => ({ workspaceId: m[1]!, recordId: m[3]! }),
    snapshot: (db, ids) => db.getMediaAsset(ids.recordId),
  },
  // Conversation (contains chat history)
  {
    pattern: /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/conversations\/([^/]+)$/,
    entity: 'conversation',
    action: 'delete_conversation',
    extractIds: m => ({ workspaceId: m[1]!, recordId: m[3]! }),
    snapshot: async () => null, // Conversations don't have a single-row get; log the action only
  },
  // Project member
  {
    pattern: /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/members\/([^/]+)$/,
    entity: 'project_member',
    action: 'delete_project_member',
    extractIds: m => ({ workspaceId: m[1]!, recordId: m[3]! }),
    snapshot: async () => null,
  },
  // Workspace member
  {
    pattern: /^\/api\/workspaces\/([^/]+)\/members\/([^/]+)$/,
    entity: 'workspace_member',
    action: 'delete_workspace_member',
    extractIds: m => ({ workspaceId: m[1]!, recordId: m[2]! }),
    snapshot: async () => null,
  },
  // Project (CASCADE deletes child records — logged for parent tracing)
  {
    pattern: /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)$/,
    entity: 'project',
    action: 'delete_project',
    extractIds: m => ({ workspaceId: m[1]!, recordId: m[2]! }),
    snapshot: (db, ids) => db.getProjectById(ids.recordId),
  },
  // Workspace (CASCADE deletes everything under it)
  {
    pattern: /^\/api\/workspaces\/([^/]+)$/,
    entity: 'workspace',
    action: 'delete_workspace',
    extractIds: m => ({ workspaceId: m[1]!, recordId: m[1]! }),
    snapshot: (db, ids) => db.getWorkspaceById(ids.recordId),
  },
  // User account (CASCADE deletes entire user tree)
  {
    pattern: /^\/api\/profile$/,
    entity: 'account',
    action: 'delete_account',
    extractIds: () => ({ workspaceId: null, recordId: '' }), // recordId filled from session
    snapshot: async () => null, // Profile snapshot not useful — actor IS the profile
  },
]

// ─── Matcher ───

export function matchAuditableRoute(path: string): { route: AuditableRoute, matches: string[] } | null {
  for (const route of AUDITABLE_ROUTES) {
    const matches = path.match(route.pattern)
    if (matches) return { route, matches: [...matches] }
  }
  return null
}

// ─── Context helpers ───

export function buildAuditSnapshot(
  event: H3Event,
  route: AuditableRoute,
  matches: string[],
  snapshot: DatabaseRow | null,
  actorId: string,
): AuditSnapshot {
  const ids = route.extractIds(matches)
  return {
    entity: route.entity,
    action: route.action,
    recordId: ids.recordId || actorId, // account deletion: use actorId as recordId
    workspaceId: ids.workspaceId,
    snapshot,
    actorId,
    sourceIp: getRequestIP(event, { xForwardedFor: true }) ?? null,
    userAgent: getHeader(event, 'user-agent') ?? null,
    timestamp: Date.now(),
  }
}
