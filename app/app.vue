<script setup lang="ts">
const { t } = useContent()

const appName = computed(() => t('app.name'))
const appDescription = computed(() => t('auth.marketing_signin_desc'))
// The link-preview card (1200×630 PNG under public/), on this deployment's own address so a self-hosted Studio
// serves its own copy.
const ogImage = `${useRuntimeConfig().public.siteUrl.replace(/\/+$/, '')}/og-studio-1200x630.png`

// Global title template — each page sets a short, page-specific title and the
// brand suffix is appended here. Pages that set no title fall back to the bare
// brand name (and the guard avoids "Contentrain Studio · Contentrain Studio").
useHead({
  titleTemplate: (title?: string | null) =>
    title && title !== appName.value ? `${title} · ${appName.value}` : appName.value,
})

// Dictionary-driven SEO defaults applied app-wide. Pages override the document
// title via useHead; these base description / Open Graph / Twitter tags give
// every route a complete, shareable meta set.
useSeoMeta({
  description: () => appDescription.value,
  ogType: 'website',
  ogSiteName: () => appName.value,
  ogTitle: () => appName.value,
  ogDescription: () => appDescription.value,
  ogImage,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  twitterCard: 'summary_large_image',
  twitterTitle: () => appName.value,
  twitterDescription: () => appDescription.value,
  twitterImage: ogImage,
})
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLoadingIndicator color="#3b82f6" :height="2" />
  <!-- One tooltip provider for the whole app; the atom falls back to its own
       only when mounted outside this scope. See AtomsTooltipScope. -->
  <AtomsTooltipScope>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </AtomsTooltipScope>
  <OrganismsToastProvider />
</template>
