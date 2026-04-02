<script setup lang="ts">
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'radix-vue'

const { t } = useContent()
const { isOpen, close } = useMobileSidebar()
const route = useRoute()

// Auto-close on navigation
watch(() => route.fullPath, () => close())
</script>

<template>
  <DialogRoot v-model:open="isOpen">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
      />

      <DialogContent
        class="fixed inset-y-0 left-0 z-50 w-60 shadow-xl data-[state=open]:animate-in data-[state=open]:slide-in-from-left data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left"
      >
        <DialogTitle class="sr-only">
          {{ t('common.menu') }}
        </DialogTitle>

        <OrganismsAppSidebar />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
