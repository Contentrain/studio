/**
 * Scheduled publication registry (S-03).
 *
 * `publish_at` / `expire_at` are entry meta in Git and gate delivery at build
 * time; nothing rebuilt the site when a boundary passed. Every save that
 * carries a future boundary registers it here; the `schedule-trigger` plugin
 * claims due rows and fires a CDN rebuild + the deploy hook.
 *
 * Registration is best-effort and never fails the write: the content is
 * already committed, and a missed registration is recovered by the next
 * save of the same entry.
 */

import type { ScheduledPublicationInput } from '~~/server/providers/database'
import type { EntrySchedule } from './content-engine/types'

export interface RegisterSchedulesInput {
  projectId: string
  modelId: string
  locale: string
  entryIds: string[]
  schedule: EntrySchedule
}

/** Future boundaries → rows; past or cleared boundaries → kinds to drop. */
export function planScheduleRows(input: RegisterSchedulesInput & { workspaceId: string }, now = new Date()): {
  upserts: ScheduledPublicationInput[]
  clearKinds: Array<'publish' | 'expire'>
} {
  const upserts: ScheduledPublicationInput[] = []
  const clearKinds: Array<'publish' | 'expire'> = []

  for (const kind of ['publish', 'expire'] as const) {
    const key = kind === 'publish' ? 'publish_at' : 'expire_at'
    if (!(key in input.schedule)) continue // absent = leave alone
    const value = input.schedule[key]
    if (value === null || value === undefined || value === '') {
      clearKinds.push(kind)
      continue
    }
    const at = new Date(value)
    if (Number.isNaN(at.getTime()) || at <= now) {
      // Already in the past: delivery handles it on the next build; nothing to wait for.
      clearKinds.push(kind)
      continue
    }
    for (const entryId of input.entryIds) {
      upserts.push({
        project_id: input.projectId,
        workspace_id: input.workspaceId,
        model_id: input.modelId,
        entry_id: entryId,
        locale: input.locale,
        kind,
        fire_at: at.toISOString(),
      })
    }
  }

  return { upserts, clearKinds }
}

export async function registerEntrySchedules(input: RegisterSchedulesInput): Promise<void> {
  if (input.entryIds.length === 0) return
  if (!('publish_at' in input.schedule) && !('expire_at' in input.schedule)) return

  const db = useDatabaseProvider()
  const project = await db.getProjectById(input.projectId, 'id, workspace_id')
  if (!project?.workspace_id) return

  const { upserts, clearKinds } = planScheduleRows({ ...input, workspaceId: String(project.workspace_id) })
  if (clearKinds.length > 0)
    await db.clearScheduledPublications(input.projectId, input.modelId, input.entryIds, input.locale, clearKinds)
  if (upserts.length > 0)
    await db.upsertScheduledPublications(upserts)
}

export async function clearEntrySchedules(projectId: string, modelId: string, entryIds: string[], locale?: string): Promise<void> {
  if (entryIds.length === 0) return
  await useDatabaseProvider().clearScheduledPublications(projectId, modelId, entryIds, locale)
}
