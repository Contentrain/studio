<script setup lang="ts">
const { t } = useContent()

const links = [
  { href: 'https://contentrain.io', key: 'product_links.home' },
  { href: 'https://docs.contentrain.io', key: 'product_links.docs' },
  { href: 'https://ai.contentrain.io', key: 'product_links.ai' },
  { href: 'https://migrate.contentrain.io', key: 'product_links.migrate' },
]
</script>

<template>
  <nav :aria-label="t('product_links.label')">
    <ul class="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted">
      <li v-for="link in links" :key="link.href">
        <a
          :href="link.href"
          target="_blank"
          rel="noopener"
          class="rounded transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:hover:text-secondary-100"
        >
          {{ t(link.key) }}
        </a>
      </li>
    </ul>
  </nav>
</template>
