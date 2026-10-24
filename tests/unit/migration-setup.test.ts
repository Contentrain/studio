import { describe, expect, it } from 'vitest'
import { migrationSetupComplete, migrationSetupSteps } from '../../server/utils/migration-setup'
import type { MigrationSetupFacts, MigrationSetupStep } from '../../server/utils/migration-setup'

/**
 * The setup wizard's steps, read from the state each one already has: the grant's binding (049) and media record
 * (053), the comments, the latest import job, and the setup record (054). One row per state the wizard shows.
 */

const facts = (over: { record?: MigrationSetupFacts['record'], binding?: Partial<MigrationSetupFacts['binding']>, comments?: Partial<MigrationSetupFacts['comments']>, media?: Partial<MigrationSetupFacts['media']> } = {}): MigrationSetupFacts => ({
  record: over.record ?? {},
  binding: { state: 'written', detail: {}, ...over.binding },
  comments: { imported: 0, export: null, atSource: 0, sourceExport: false, ...over.comments },
  media: { job: null, grantState: null, grantDetail: {}, manifest: false, ...over.media },
})
const step = (f: MigrationSetupFacts, name: MigrationSetupStep) => migrationSetupSteps(f).find(s => s.step === name)!
const job = (status: string, over: Record<string, unknown> = {}) => ({ id: 'job-1', status, ...over })
const PR = 'https://github.com/acme/site/pull/3'

describe('migrationSetupSteps', () => {
  it.each([
    ['bound', { state: 'written' }, {}, { state: 'done', reason: 'bound' }],
    ['bound, forms over the plan', { state: 'partial' }, {}, { state: 'done', reason: 'over_limit' }],
    ['a pull request into a protected branch', { state: 'pr_open', detail: { prUrl: PR } }, {}, { state: 'waiting', reason: 'pull_request', pullRequestUrl: PR }],
    ['a review branch: the owner approves', { state: 'pr_open', detail: { branch: 'cr/studio/binding/1', review: true } }, {}, { state: 'needs_you', reason: 'review', branch: 'cr/studio/binding/1' }],
    ['another binding on the site', { state: 'conflict' }, {}, { state: 'needs_you', reason: 'conflict' }],
    ['the write failed', { state: 'failed' }, {}, { state: 'needs_you', reason: 'failed' }],
    ['never bound', { state: null }, {}, { state: 'needs_you', reason: 'unbound' }],
    ['never bound, skipped', { state: null }, { skip_forms: true }, { state: 'skipped', reason: 'skipped' }],
    ['skipping never hides a binding', { state: 'written' }, { skip_forms: true }, { state: 'done', reason: 'bound' }],
  ])('forms: %s', (_name, binding, record, expected) => {
    expect(step(facts({ binding: binding as never, record }), 'forms')).toMatchObject(expected)
  })

  it.each([
    ['imported', { imported: 12 }, {}, { state: 'done', reason: 'imported' }],
    ['the held export is ready', { export: 'ready' }, {}, { state: 'needs_you', reason: 'ready' }],
    ['the handoff names an export with comments', { atSource: 40, sourceExport: true }, {}, { state: 'needs_you', reason: 'ready' }],
    ['ready, skipped', { export: 'ready' }, { skip_comments: true }, { state: 'skipped', reason: 'skipped' }],
    ['none to bring', {}, {}, { state: 'done', reason: 'none' }],
    ['the export expired', { export: 'expired' }, {}, { state: 'done', reason: 'expired' }],
  ])('comments: %s', (_name, comments, record, expected) => {
    expect(step(facts({ comments: comments as never, record }), 'comments')).toMatchObject(expected)
  })

  it.each([
    ['no job yet, a manifest to move', { manifest: true }, {}, { state: 'needs_you', reason: 'ready' }],
    ['no job, no media', {}, {}, { state: 'done', reason: 'nothing' }],
    ['importing', { job: job('running') }, {}, { state: 'waiting', reason: 'importing' }],
    ['paused for storage', { job: job('paused_quota') }, {}, { state: 'needs_you', reason: 'paused_quota' }],
    ['done, a Move click not applied yet', { job: job('done', { apply_approver: { id: 'u-1' } }) }, {}, { state: 'waiting', reason: 'applying' }],
    ['done, nobody asked for the apply', { job: job('done') }, {}, { state: 'needs_you', reason: 'apply_pending' }],
    ['the click\'s apply landed', { job: job('done', { apply_approver: { id: 'u-1' } }) }, { media_apply: { jobId: 'job-1', status: 'merged', at: 't' } }, { state: 'done', reason: 'moved' }],
    ['the click\'s apply is held for review', { job: job('done') }, { media_apply: { jobId: 'job-1', status: 'pending_review', branch: 'cr/media/1', at: 't' } }, { state: 'needs_you', reason: 'review', branch: 'cr/media/1' }],
    ['the click\'s apply is a pull request', { job: job('done') }, { media_apply: { jobId: 'job-1', status: 'pull_request', pullRequestUrl: PR, at: 't' } }, { state: 'waiting', reason: 'pull_request', pullRequestUrl: PR }],
    ['the click\'s apply failed', { job: job('done') }, { media_apply: { jobId: 'job-1', status: 'failed', code: 'conflict', at: 't' } }, { state: 'needs_you', reason: 'apply_failed' }],
    ['an apply of an older job says nothing about this one', { job: job('done') }, { media_apply: { jobId: 'job-0', status: 'merged', at: 't' } }, { state: 'needs_you', reason: 'apply_pending' }],
    ['the grant\'s apply landed', { job: job('done'), grantState: 'connected', grantDetail: { jobId: 'job-1' } }, {}, { state: 'done', reason: 'moved' }],
    ['the grant\'s apply is held for review', { job: job('done'), grantState: 'review', grantDetail: { jobId: 'job-1', branch: 'cr/media/2' } }, {}, { state: 'needs_you', reason: 'review', branch: 'cr/media/2' }],
    ['a failed click apply after the grant\'s own landed', { job: job('done'), grantState: 'connected', grantDetail: { jobId: 'job-1' } }, { media_apply: { jobId: 'job-1', status: 'failed', at: 't' } }, { state: 'done', reason: 'moved' }],
    ['the job failed', { job: job('failed') }, {}, { state: 'needs_you', reason: 'failed' }],
    ['kept in the repository', { manifest: true }, { skip_images: true }, { state: 'skipped', reason: 'skipped' }],
  ])('images: %s', (_name, media, record, expected) => {
    expect(step(facts({ media: media as never, record: record as never }), 'images')).toMatchObject(expected)
  })

  it.each([
    ['never checked', {}, { state: 'needs_you', reason: 'unchecked' }],
    ['merged, not seen yet', { live_check: { nonce: 'n', status: 'merged', at: 't' } }, { state: 'needs_you', reason: 'not_seen' }],
    ['a pull request', { live_check: { nonce: 'n', status: 'pull_request', pullRequestUrl: PR, at: 't' } }, { state: 'waiting', reason: 'pull_request', pullRequestUrl: PR }],
    ['held for review', { live_check: { nonce: 'n', status: 'pending_review', branch: 'cr/studio/live-check/1', at: 't' } }, { state: 'needs_you', reason: 'review', branch: 'cr/studio/live-check/1' }],
    ['seen on the live site', { live_check: { nonce: 'n', status: 'merged', at: 't', seenAt: 't2', seenBy: 'fetch' } }, { state: 'done', reason: 'checked' }],
    ['not on a host yet', { skip_live: true }, { state: 'skipped', reason: 'no_host' }],
  ])('live: %s', (_name, record, expected) => {
    expect(step(facts({ record: record as never }), 'live')).toMatchObject(expected)
  })

  it('the setup is over when every step is done or skipped, and not before', () => {
    const over = facts({ record: { skip_live: true }, comments: { imported: 3 }, media: { job: job('done'), grantState: 'connected', grantDetail: { jobId: 'job-1' } } })
    expect(migrationSetupComplete(migrationSetupSteps(over))).toBe(true)
    expect(migrationSetupComplete(migrationSetupSteps({ ...over, record: {} }))).toBe(false)
  })
})
