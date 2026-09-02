<script setup lang="ts">
import { formatBuildVersion } from '~~/shared/utils/build-info'

definePageMeta({
  // Public — AGPL §13 source offer must be reachable without authentication.
  auth: false,
})

const { t } = useContent()
useHead({ title: () => t('about.title') })

const { public: pub } = useRuntimeConfig()
const deployment = computed(() => {
  const d = (pub as { deployment?: { profile?: string, edition?: string, billingMode?: string } }).deployment
  return d ?? { profile: 'unknown', edition: 'unknown', billingMode: 'unknown' }
})

// Tag plus commit: the first thing a bug report asks for, and until now the
// one fact this page could not give. Stamped at build time (nuxt.config.ts).
const buildVersion = computed(() => formatBuildVersion((pub as { build?: { version?: string, commit?: string } }).build))

const repoUrl = 'https://github.com/Contentrain/studio'

const linkClass = 'rounded text-primary-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400'
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-12">
    <NuxtLink to="/" class="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded">
      <span class="icon-[annon--arrow-left] size-4" aria-hidden="true" />
      {{ t('common.back') }}
    </NuxtLink>

    <h1 class="mt-6 text-2xl font-semibold text-heading dark:text-secondary-100">
      {{ t('about.title') }}
    </h1>

    <p class="mt-3 text-sm text-body dark:text-secondary-300">
      {{ t('about.intro_prefix') }} <a :href="repoUrl" :class="linkClass" target="_blank" rel="noopener noreferrer">{{ t('app.name') }}</a>{{ t('about.intro_suffix') }}
    </p>

    <section class="mt-8 rounded-lg border border-secondary-200 p-5 dark:border-secondary-800">
      <h2 class="text-sm font-medium text-heading dark:text-secondary-100">
        {{ t('about.source_title') }}
      </h2>
      <p class="mt-2 text-sm text-body dark:text-secondary-300">
        {{ t('about.source_intro') }}
      </p>
      <p class="mt-2 font-mono text-sm">
        <a :href="repoUrl" :class="linkClass" target="_blank" rel="noopener noreferrer">{{ repoUrl }}</a>
      </p>
      <p class="mt-3 text-xs text-muted">
        {{ t('about.source_modified_note') }}
      </p>
      <p class="mt-3 text-xs text-muted">
        {{ t('about.ee_note') }} {{ t('about.see_license') }} <a :href="`${repoUrl}/blob/main/ee/LICENSE`" :class="linkClass" target="_blank" rel="noopener noreferrer">ee/LICENSE</a>.
      </p>
    </section>

    <section class="mt-6 rounded-lg border border-secondary-200 p-5 dark:border-secondary-800">
      <h2 class="text-sm font-medium text-heading dark:text-secondary-100">
        {{ t('about.licenses_title') }}
      </h2>
      <ul class="mt-3 space-y-2 text-sm text-body dark:text-secondary-300">
        <li>
          <span class="font-medium">{{ t('about.license_core_label') }}</span> {{ t('about.license_core_name') }} — <a :href="`${repoUrl}/blob/main/LICENSE`" :class="linkClass" target="_blank" rel="noopener noreferrer">LICENSE</a> {{ t('common.and') }} <a :href="`${repoUrl}/blob/main/LICENSE-EXCEPTIONS`" :class="linkClass" target="_blank" rel="noopener noreferrer">LICENSE-EXCEPTIONS</a>
        </li>
        <li>
          <span class="font-medium">{{ t('about.license_ee_label') }}</span> {{ t('about.license_ee_name') }} — <a :href="`${repoUrl}/blob/main/ee/LICENSE`" :class="linkClass" target="_blank" rel="noopener noreferrer">ee/LICENSE</a>
        </li>
      </ul>
    </section>

    <section class="mt-6 rounded-lg border border-secondary-200 p-5 dark:border-secondary-800">
      <h2 class="text-sm font-medium text-heading dark:text-secondary-100">
        {{ t('about.deployment_title') }}
      </h2>
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt class="text-muted">
          {{ t('about.version_label') }}
        </dt>
        <dd class="font-mono text-body dark:text-secondary-300">
          {{ buildVersion }}
        </dd>
        <dt class="text-muted">
          {{ t('about.profile_label') }}
        </dt>
        <dd class="text-body dark:text-secondary-300">
          {{ deployment.profile }}
        </dd>
        <dt class="text-muted">
          {{ t('about.edition_label') }}
        </dt>
        <dd class="text-body dark:text-secondary-300">
          {{ deployment.edition }}
        </dd>
        <dt class="text-muted">
          {{ t('about.billing_label') }}
        </dt>
        <dd class="text-body dark:text-secondary-300">
          {{ deployment.billingMode }}
        </dd>
      </dl>
    </section>

    <p class="mt-8 text-xs text-muted">
      {{ t('about.powered_by') }}
    </p>
  </div>
</template>
