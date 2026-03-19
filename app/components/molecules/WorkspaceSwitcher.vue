<script setup lang="ts">
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'radix-vue'

const { workspaces, activeWorkspace, fetchWorkspaces, setActiveWorkspace } = useWorkspaces()
const router = useRouter()

const open = ref(false)

async function switchWorkspace(id: string, slug: string) {
  setActiveWorkspace(id)
  open.value = false
  await router.push(`/w/${slug}`)
}

onMounted(() => {
  if (workspaces.value.length === 0) fetchWorkspaces()
})
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverAnchor />
    <PopoverTrigger
      class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-heading transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-secondary-100 dark:hover:bg-secondary-900"
      type="button"
    >
      <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary-600 text-[10px] font-bold text-white">
        {{ activeWorkspace?.name?.charAt(0)?.toUpperCase() ?? 'W' }}
      </span>
      <span class="min-w-0 flex-1 truncate">
        {{ activeWorkspace?.name ?? 'Workspace' }}
      </span>
      <span class="icon-[annon--chevron-down] size-4 shrink-0 text-muted" aria-hidden="true" />
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent
        side="bottom"
        align="start"
        :side-offset="4"
        class="z-50 w-56 rounded-lg border border-secondary-200 bg-white p-1 shadow-lg dark:border-secondary-800 dark:bg-secondary-950"
      >
        <div class="px-2 py-1.5 text-xs font-medium text-muted">
          Workspaces
        </div>
        <button
          v-for="ws in workspaces"
          :key="ws.id"
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-secondary-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:bg-secondary-900"
          :class="ws.id === activeWorkspace?.id ? 'text-primary-600 dark:text-primary-400' : 'text-body dark:text-secondary-300'"
          @click="switchWorkspace(ws.id, ws.slug)"
        >
          <span class="flex size-5 shrink-0 items-center justify-center rounded text-[9px] font-bold text-white" :class="ws.id === activeWorkspace?.id ? 'bg-primary-600' : 'bg-secondary-400 dark:bg-secondary-600'">
            {{ ws.name.charAt(0).toUpperCase() }}
          </span>
          <span class="truncate">{{ ws.name }}</span>
          <span v-if="ws.id === activeWorkspace?.id" class="icon-[annon--check] ml-auto size-4 shrink-0" aria-hidden="true" />
        </button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
