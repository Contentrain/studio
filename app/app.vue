<script setup lang="ts">
import { Toaster } from 'vue-sonner'
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLoadingIndicator color="#3b82f6" :height="2" />
  <Toaster
    position="bottom-right"
    :duration="4000"
    rich-colors
    close-button
    :theme="useTheme().isDark.value ? 'dark' : 'light'"
  />
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
