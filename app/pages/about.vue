<script setup lang="ts">
definePageMeta({
  // Public — AGPL §13 source offer must be reachable without authentication.
  auth: false,
})

const { public: pub } = useRuntimeConfig()
const deployment = computed(() => {
  const d = (pub as { deployment?: { profile?: string, edition?: string, billingMode?: string } }).deployment
  return d ?? { profile: 'unknown', edition: 'unknown', billingMode: 'unknown' }
})

const repoUrl = 'https://github.com/Contentrain/studio'
const eeRepoNote = 'The `ee/` directory is proprietary and not covered by AGPL-3.0.'
</script>

<template>
  <div class="mx-auto max-w-2xl px-6 py-12">
    <NuxtLink to="/" class="inline-flex items-center gap-2 text-sm text-muted transition-colors hover:text-heading focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 rounded">
      <span class="icon-[annon--arrow-left] size-4" aria-hidden="true" />
      Back
    </NuxtLink>

    <h1 class="mt-6 text-2xl font-semibold text-heading dark:text-secondary-100">
      About this deployment
    </h1>

    <p class="mt-3 text-sm text-body dark:text-secondary-300">
      This site is powered by <a :href="repoUrl" class="rounded text-primary-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" target="_blank" rel="noopener noreferrer">Contentrain Studio</a>, an open-source content operations platform for Git-backed structured content.
    </p>

    <section class="mt-8 rounded-lg border border-secondary-200 p-5 dark:border-secondary-800">
      <h2 class="text-sm font-medium text-heading dark:text-secondary-100">
        Source code (AGPL-3.0 §13)
      </h2>
      <p class="mt-2 text-sm text-body dark:text-secondary-300">
        The AGPL-3.0 core powering this site is available at:
      </p>
      <p class="mt-2 font-mono text-sm">
        <a :href="repoUrl" class="rounded text-primary-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" target="_blank" rel="noopener noreferrer">{{ repoUrl }}</a>
      </p>
      <p class="mt-3 text-xs text-muted">
        If this deployment runs a modified version, the operator is required by AGPL-3.0 §13 to make the corresponding source available to interacting users. Contact the deployment operator for details.
      </p>
      <p class="mt-3 text-xs text-muted">
        {{ eeRepoNote }} See <a :href="`${repoUrl}/blob/main/ee/LICENSE`" class="rounded text-primary-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" target="_blank" rel="noopener noreferrer">ee/LICENSE</a>.
      </p>
    </section>

    <section class="mt-6 rounded-lg border border-secondary-200 p-5 dark:border-secondary-800">
      <h2 class="text-sm font-medium text-heading dark:text-secondary-100">
        Licenses
      </h2>
      <ul class="mt-3 space-y-2 text-sm text-body dark:text-secondary-300">
        <li>
          <span class="font-medium">Core:</span> GNU Affero General Public License v3.0 — <a :href="`${repoUrl}/blob/main/LICENSE`" class="rounded text-primary-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" target="_blank" rel="noopener noreferrer">LICENSE</a> and <a :href="`${repoUrl}/blob/main/LICENSE-EXCEPTIONS`" class="rounded text-primary-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" target="_blank" rel="noopener noreferrer">LICENSE-EXCEPTIONS</a>
        </li>
        <li>
          <span class="font-medium">Enterprise Edition (ee/):</span> Proprietary — <a :href="`${repoUrl}/blob/main/ee/LICENSE`" class="rounded text-primary-600 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 dark:text-primary-400" target="_blank" rel="noopener noreferrer">ee/LICENSE</a>
        </li>
      </ul>
    </section>

    <section class="mt-6 rounded-lg border border-secondary-200 p-5 dark:border-secondary-800">
      <h2 class="text-sm font-medium text-heading dark:text-secondary-100">
        Deployment
      </h2>
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt class="text-muted">
          Profile
        </dt>
        <dd class="text-body dark:text-secondary-300">
          {{ deployment.profile }}
        </dd>
        <dt class="text-muted">
          Edition
        </dt>
        <dd class="text-body dark:text-secondary-300">
          {{ deployment.edition }}
        </dd>
        <dt class="text-muted">
          Billing
        </dt>
        <dd class="text-body dark:text-secondary-300">
          {{ deployment.billingMode }}
        </dd>
      </dl>
    </section>

    <p class="mt-8 text-xs text-muted">
      Powered by Contentrain Studio.
    </p>
  </div>
</template>
