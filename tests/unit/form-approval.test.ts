import type { GitProvider } from '../../server/providers/git'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { approveSubmissionAsContent } from '../../server/utils/form-types'

const engine = vi.hoisted(() => ({ saveContent: vi.fn(), mergeBranch: vi.fn() }))
vi.mock('~~/server/utils/content-engine', () => ({ createContentEngine: () => engine }))

const pending = { id: 'sub-1', project_id: 'p1', model_id: 'contact', locale: 'tr', status: 'pending', data: { name: 'Ada' } }
const git = {} as GitProvider
const db = { getFormSubmission: vi.fn(), updateFormSubmissionStatus: vi.fn() }
const approve = () => approveSubmissionAsContent(pending, git, '.contentrain', 'p1', 'u1')

beforeEach(() => {
  vi.stubGlobal('useDatabaseProvider', () => db)
  vi.stubGlobal('invalidateBrainCache', vi.fn())
  db.getFormSubmission.mockResolvedValue({ ...pending })
  db.updateFormSubmissionStatus.mockResolvedValue({})
  engine.saveContent.mockResolvedValue({ branch: 'review', validation: { valid: true } })
  engine.mergeBranch.mockResolvedValue({ merged: true })
})

describe('form approval delivery', () => {
  it('concurrent approvals and retries write one stable identity in the stored locale', async () => {
    const ids = await Promise.all([approve(), approve(), approve(), approve()])
    expect(new Set(ids).size).toBe(1)
    for (const call of engine.saveContent.mock.calls) {
      expect(call[1]).toBe('tr')
      expect(Object.keys(call[2])).toEqual([ids[0]])
    }
    expect(await approve()).toBe(ids[0])
  })

  it('does not overwrite an approved entry, even when the caller holds a stale pending row', async () => {
    db.getFormSubmission.mockResolvedValue({ ...pending, status: 'approved', entry_id: 'legacy-id' })
    expect(await approve()).toBe('legacy-id')
    expect(engine.saveContent).not.toHaveBeenCalled()
    expect(db.updateFormSubmissionStatus).not.toHaveBeenCalled()
  })

  it('does not acknowledge validation failure', async () => {
    engine.saveContent.mockResolvedValue({ branch: '', validation: { valid: false } })
    await expect(approve()).rejects.toMatchObject({ statusCode: 422, message: 'forms.approve_validation_failed' })
    expect(engine.mergeBranch).not.toHaveBeenCalled()
    expect(db.updateFormSubmissionStatus).not.toHaveBeenCalled()
  })

  it('propagates merge failure and reuses the same identity on retry', async () => {
    engine.mergeBranch.mockRejectedValueOnce(new Error('merge unavailable'))
    await expect(approve()).rejects.toThrow('merge unavailable')
    expect(db.updateFormSubmissionStatus).not.toHaveBeenCalled()
    const firstId = Object.keys(engine.saveContent.mock.calls[0]![2])[0]
    expect(await approve()).toBe(firstId)
  })

  it('does not acknowledge a merge conflict returned without an exception', async () => {
    engine.mergeBranch.mockResolvedValue({ merged: false })
    await expect(approve()).rejects.toMatchObject({ statusCode: 409, message: 'forms.approve_merge_failed' })
    expect(db.updateFormSubmissionStatus).not.toHaveBeenCalled()
  })

  it('recovers a Git success followed by a DB failure without creating another entry', async () => {
    db.updateFormSubmissionStatus.mockRejectedValueOnce(new Error('DB unavailable'))
    await expect(approve()).rejects.toThrow('DB unavailable')
    const firstId = Object.keys(engine.saveContent.mock.calls[0]![2])[0]
    expect(await approve()).toBe(firstId)
  })

  it('rejects missing or differently scoped persisted submissions before writing', async () => {
    db.getFormSubmission.mockResolvedValue({ ...pending, project_id: 'other' })
    await expect(approve()).rejects.toMatchObject({ statusCode: 404, message: 'forms.submission_not_found' })
    expect(engine.saveContent).not.toHaveBeenCalled()
  })
})
