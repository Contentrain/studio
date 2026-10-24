/**
 * The setup of a project Migrate delivered, as `GET …/migration` reads it (`setup`, `server/utils/migration-setup.ts`):
 * one shape for the setup wizard and the overview's summary line, loaded once and reloaded after each click.
 */
import type { Ref } from 'vue'

export type MigrationSetupStepName = 'forms' | 'comments' | 'images' | 'live'
export type MigrationSetupStepState = 'done' | 'waiting' | 'needs_you' | 'skipped'

export interface MigrationSetupStep {
  step: MigrationSetupStepName
  state: MigrationSetupStepState
  reason: string
  branch?: string | null
  pullRequestUrl?: string | null
}

export interface MigrationSetupView {
  grant: { kind: string, plan: string | null }
  steps: MigrationSetupStep[]
  completedAt: string | null
  liveSiteUrl: string | null
  liveCheck: { status: 'merged' | 'pull_request' | 'pending_review', at: string, seenAt: string | null, seenBy: 'fetch' | 'owner' | null } | null
  forms: { models: number | null, overLimit: number }
  media: { jobId: string | null, refusedTooLarge: number | null }
}

export interface MigrationState {
  present: boolean
  summary: { siteUrl: string, comments?: { total: number } } | null
  commentsImported: number
  setup: MigrationSetupView | null
}

/** The wizard's screens: the four steps, after the "your site is in Studio" one. */
export type MigrationSetupScreen = 'main' | MigrationSetupStepName

export const MIGRATION_SETUP_STEP_NAMES: MigrationSetupStepName[] = ['forms', 'comments', 'images', 'live']

/** A step that still asks for something: the owner's click, or Studio or a reviewer on its way. */
export function migrationSetupOpen(step: MigrationSetupStep | undefined): boolean {
  return !!step && (step.state === 'needs_you' || step.state === 'waiting')
}

export function useMigrationSetup(workspaceId: Ref<string>, projectId: Ref<string>) {
  const state = ref<MigrationState | null>(null)
  const base = () => `/api/workspaces/${workspaceId.value}/projects/${projectId.value}/migration`

  async function load() {
    try {
      state.value = await $fetch<MigrationState>(base())
    }
    catch {
      state.value = null
    }
  }

  watch(projectId, load, { immediate: true })

  const setup = computed(() => state.value?.present ? state.value.setup : null)
  const step = (name: MigrationSetupStepName) => setup.value?.steps.find(s => s.step === name)
  /** Where "Continue setup" opens: the first step that still asks for something, else the last one. */
  const firstOpen = computed<MigrationSetupStepName>(() => MIGRATION_SETUP_STEP_NAMES.find(name => migrationSetupOpen(step(name))) ?? 'live')

  return { state, setup, step, firstOpen, base, load }
}
