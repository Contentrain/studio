<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'radix-vue'

defineProps<{
  role: 'user' | 'assistant'
  text: string
  userAvatarUrl?: string | null
  userName?: string | null
  /** Context items attached to this message */
  contextItems?: ReadonlyArray<{ readonly type: string, readonly label: string, readonly sublabel?: string }>
  /** Files/links attached to this message */
  attachments?: ReadonlyArray<{ readonly kind: 'text' | 'document' | 'image', readonly filename: string, readonly previewUrl?: string, readonly mime?: string, readonly destination?: 'context' | 'media' }>
}>()

const { t } = useContent()

// Full-size image preview (lightbox).
const lightboxUrl = ref<string | null>(null)

function attachmentIcon(kind: string, mime?: string): string {
  if (kind === 'document') return 'icon-[annon--file-text]'
  if (mime === 'text/uri-list') return 'icon-[annon--link-1]'
  return 'icon-[annon--file-text]'
}

const contextTypeIcons: Record<string, string> = {
  model: 'icon-[annon--layers]',
  entry: 'icon-[annon--file-text]',
  field: 'icon-[annon--code]',
}
</script>

<template>
  <div class="flex gap-3" :class="role === 'user' ? 'flex-row-reverse' : ''">
    <!-- Avatar -->
    <div class="shrink-0 pt-0.5">
      <!-- User: real avatar -->
      <AtomsAvatar v-if="role === 'user'" :src="userAvatarUrl" :name="userName" size="sm" />
      <!-- AI: Contentrain logo -->
      <div v-else class="flex size-7 items-center justify-center rounded-full bg-secondary-100 dark:bg-secondary-800">
        <AtomsLogo variant="icon" color="auto" class="size-4" />
      </div>
    </div>

    <!-- Content -->
    <div class="min-w-0 max-w-[85%]">
      <!-- Attached context chips (user messages only) -->
      <div
        v-if="contextItems && contextItems.length > 0" class="mb-1 flex flex-wrap gap-1"
        :class="role === 'user' ? 'justify-end' : ''"
      >
        <span
          v-for="(item, idx) in contextItems" :key="idx"
          class="inline-flex items-center gap-1 rounded-md bg-secondary-100 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:bg-secondary-800"
        >
          <span :class="contextTypeIcons[item.type] ?? 'icon-[annon--code]'" class="size-2.5" aria-hidden="true" />
          <span class="truncate">{{ item.label }}</span>
          <span v-if="item.sublabel" class="truncate opacity-60">· {{ item.sublabel }}</span>
        </span>
      </div>

      <!-- Attachments (files/links/images) -->
      <div
        v-if="attachments && attachments.length > 0" class="mb-1 flex flex-wrap gap-1.5"
        :class="role === 'user' ? 'justify-end' : ''"
      >
        <template v-for="(att, idx) in attachments" :key="idx">
          <!-- Image thumbnail → lightbox -->
          <button
            v-if="att.kind === 'image' && att.previewUrl" type="button"
            class="relative overflow-hidden rounded-lg border border-secondary-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:border-secondary-700"
            :aria-label="t('chat.view_image')" @click="lightboxUrl = att.previewUrl ?? null"
          >
            <NuxtImg :src="att.previewUrl" :alt="att.filename" class="size-16 object-cover" />
            <span
              v-if="att.destination === 'media'"
              class="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[8px] font-semibold uppercase tracking-wide text-white"
            >{{
              t('chat.dest_media') }}</span>
          </button>
          <!-- File / link chip -->
          <span
            v-else
            class="inline-flex max-w-45 items-center gap-1 rounded-md bg-secondary-100 px-1.5 py-0.5 text-[10px] font-medium text-muted dark:bg-secondary-800"
          >
            <span :class="attachmentIcon(att.kind, att.mime)" class="size-2.5 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ att.filename }}</span>
          </span>
        </template>
      </div>

      <div
        v-if="text" class="rounded-2xl px-4 py-2.5 text-sm" :class="role === 'user'
          ? 'bg-primary-600 text-white dark:bg-primary-500'
          : 'bg-secondary-50 text-heading dark:bg-secondary-900 dark:text-secondary-100'
        "
      >
        <!-- User: plain text -->
        <p v-if="role === 'user'" class="whitespace-pre-wrap">
          {{ text }}
        </p>

        <!-- Assistant: rendered markdown -->
        <AtomsChatMarkdown v-else :text="text" />
      </div>
    </div>

    <!-- Image lightbox -->
    <DialogRoot :open="!!lightboxUrl" @update:open="(v) => { if (!v) lightboxUrl = null }">
      <DialogPortal>
        <DialogOverlay
          class="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=open]:fade-in-0"
        />
        <DialogContent
          class="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col focus:outline-none"
          @escape-key-down="lightboxUrl = null"
        >
          <DialogTitle class="sr-only">
            {{ t('chat.view_image') }}
          </DialogTitle>
          <NuxtImg
            v-if="lightboxUrl" :src="lightboxUrl" alt=""
            class="max-h-[92vh] max-w-[92vw] rounded-lg object-contain"
          />
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
