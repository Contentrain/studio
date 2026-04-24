<script setup lang="ts">
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'radix-vue'

const { t } = useContent()
const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace, createWorkspace } = useWorkspaces()
const { projects } = useProjects()
const deployment = useDeployment()
const route = useRoute()
const router = useRouter()

const open = ref(false)
const showCreate = ref(false)
const newName = ref('')
const creating = ref(false)

// Detect if we're inside a project
const currentProjectId = computed(() => route.params.projectId as string | undefined)
const activeProject = computed(() =>
  projects.value.find(p => p.id === currentProjectId.value) ?? null,
)

async function switchWorkspace(id: string, slug: string) {
  setActiveWorkspace(id)
  open.value = false
  await router.push(`/w/${slug}`)
}

async function handleCreate() {
  if (!newName.value.trim()) return
  creating.value = true
  try {
    const ws = await createWorkspace({ name: newName.value.trim(), slug: slugify(newName.value) })
    open.value = false
    showCreate.value = false
    newName.value = ''
    await router.push(`/w/${ws.slug}`)
  }
  finally {
    creating.value = false
  }
}

type BadgeVariant = 'primary' | 'info' | 'warning' | 'secondary'

const planBadgeVariant: Record<string, BadgeVariant> = {
  community: 'secondary',
  free: 'secondary',
  starter: 'secondary',
  pro: 'primary',
  enterprise: 'warning',
}

/**
 * Resolve the plan tier displayed on each workspace row.
 *
 * - Community Edition: every row collapses to the `community` tier —
 *   there is no managed subscription and the AGPL core runs with
 *   unlimited usage on the operator's infrastructure.
 * - Operator-managed profiles (on-premise / dedicated-flat): the
 *   workspace.plan column is set by the operator; display it as-is,
 *   falling back to `enterprise` if unset (matches the server-side
 *   `defaultPlan` for these profiles).
 * - Managed profile: workspace.plan reflects the subscription state
 *   (webhook-synced); display it directly, falling back to `free`
 *   for workspaces that never completed checkout.
 *
 * Subscription granularity (trial / past_due / canceled) is
 * intentionally flattened here — the full state lives on the Billing
 * tab. The "Community Edition" / "On-premise" context is communicated
 * on Overview and Billing panels, not duplicated inside this badge.
 */
function resolveDisplayPlan(ws: { plan?: string | null }): string {
  if (deployment.isCommunity.value) return 'community'
  if (deployment.isOperatorManagedPlan.value) {
    const plan = ws.plan ?? 'enterprise'
    return plan === 'free' ? 'enterprise' : plan
  }
  return ws.plan ?? 'free'
}

function badgeVariantFor(ws: { plan?: string | null }): BadgeVariant {
  return planBadgeVariant[resolveDisplayPlan(ws)] ?? 'secondary'
}

function badgeLabelFor(ws: { plan?: string | null }): string {
  const plan = resolveDisplayPlan(ws)
  const labels: Record<string, string> = {
    community: t('billing.plan_community'),
    free: t('billing.state_free'),
    starter: t('billing.plan_starter'),
    pro: t('billing.plan_pro'),
    enterprise: t('billing.plan_enterprise'),
  }
  return labels[plan] ?? plan
}

onMounted(() => {
  if (workspaces.value.length === 0) fetchWorkspaces()
})
</script>

<template>
  <div>
    <!-- Workspace row -->
    <PopoverRoot v-model:open="open">
      <PopoverAnchor />
      <PopoverTrigger
        class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-heading transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-secondary-100 dark:hover:bg-secondary-900"
        type="button"
      >
        <span class="min-w-0 flex-1 truncate">
          {{ activeWorkspace?.name ?? t('workspace.default_name') }}
        </span>
        <AtomsBadge
          v-if="activeWorkspace"
          :variant="badgeVariantFor(activeWorkspace)"
          size="sm"
          class="font-display"
        >
          {{ badgeLabelFor(activeWorkspace) }}
        </AtomsBadge>
        <span class="icon-[annon--chevron-down] size-3.5 shrink-0 text-muted" aria-hidden="true" />
      </PopoverTrigger>

      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="start"
          :side-offset="4"
          class="z-50 w-56 rounded-lg border border-secondary-200 bg-white p-1 shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
        >
          <div class="px-2 py-1.5 text-xs font-medium text-muted">
            {{ t('workspace.switcher_title') }}
          </div>
          <button
            v-for="ws in workspaces"
            :key="ws.id"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
            :class="ws.id === activeWorkspace?.id ? 'text-primary-600 dark:text-primary-400' : 'text-body dark:text-secondary-300'"
            @click="switchWorkspace(ws.id, ws.slug)"
          >
            <span
              class="flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white"
              :class="ws.id === activeWorkspace?.id ? 'bg-primary-600' : 'bg-secondary-400 dark:bg-secondary-600'"
            >
              {{ ws.name.charAt(0).toUpperCase() }}
            </span>
            <span class="min-w-0 flex-1 truncate">{{ ws.name }}</span>
            <AtomsBadge
              :variant="badgeVariantFor(ws)"
              size="sm"
              class="shrink-0 font-display"
            >
              {{ badgeLabelFor(ws) }}
            </AtomsBadge>
            <span v-if="ws.id === activeWorkspace?.id" class="icon-[annon--check] size-4 shrink-0" aria-hidden="true" />
          </button>

          <div class="my-1 border-t border-secondary-200 dark:border-secondary-800" />

          <template v-if="showCreate">
            <div class="p-2">
              <AtomsFormInput
                v-model="newName"
                type="text"
                :placeholder="t('workspace.create_placeholder')"
                @keydown.enter="handleCreate"
              />
              <div class="mt-2 flex gap-1.5">
                <AtomsBaseButton
                  variant="primary"
                  size="sm"
                  :disabled="!newName.trim() || creating"
                  class="flex-1"
                  @click="handleCreate"
                >
                  <span>{{ t('common.create') }}</span>
                </AtomsBaseButton>
                <AtomsBaseButton
                  size="sm"
                  class="shrink-0"
                  @click="showCreate = false; newName = ''"
                >
                  <span>{{ t('common.cancel') }}</span>
                </AtomsBaseButton>
              </div>
            </div>
          </template>
          <button
            v-else
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
            @click="showCreate = true"
          >
            <span class="icon-[annon--plus] size-4 shrink-0" aria-hidden="true" />
            <span>{{ t('workspace.create_new') }}</span>
          </button>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>

    <!-- Project row (child of workspace, shown when inside a project) -->
    <div v-if="activeProject" class="flex items-center gap-1 pl-2">
      <span class="text-secondary-300 dark:text-secondary-700" aria-hidden="true">└</span>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1">
        <span class="icon-[annon--folder] size-3.5 shrink-0 text-primary-500" aria-hidden="true" />
        <span class="min-w-0 truncate text-[13px] font-medium text-heading dark:text-secondary-100">
          {{ activeProject.repo_full_name.split('/').pop() }}
        </span>
      </div>
      <!-- Back to dashboard -->
      <NuxtLink
        v-if="activeWorkspace"
        :to="`/w/${activeWorkspace.slug}`"
        class="shrink-0 rounded p-1 text-muted transition-colors hover:bg-secondary-50 hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
        :title="t('sidebar.projects')"
      >
        <span class="icon-[annon--cross] block size-3" aria-hidden="true" />
      </NuxtLink>
    </div>
  </div>
</template>
