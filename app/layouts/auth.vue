<script setup lang="ts">
import { singleton } from '#contentrain'

const marketing = singleton('auth-marketing').locale('en').get()
</script>

<template>
  <div class="flex min-h-screen">
    <!-- Left: Auth form -->
    <div class="flex flex-1 flex-col bg-white px-4 py-12 dark:bg-secondary-950 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
      <div class="mb-4">
        <NuxtLink to="/">
          <AtomsLogo variant="icon-text" class="h-8" />
        </NuxtLink>
      </div>
      <div class="flex h-full flex-col justify-center">
        <div class="mx-auto w-full max-w-sm lg:w-96">
          <slot />
        </div>
      </div>
    </div>

    <!-- Right: Marketing visual -->
    <div class="relative hidden w-0 flex-1 bg-secondary-900 lg:block">
      <div class="flex h-full flex-col items-start justify-center px-12 xl:px-16">
        <NuxtImg
          v-if="marketing?.illustration"
          :src="marketing.illustration"
          alt=""
          class="mb-12 w-full max-w-lg"
          aria-hidden="true"
        />
        <h2 class="max-w-sm text-2xl font-semibold text-secondary-100">
          {{ marketing?.headline }}
        </h2>
        <p class="mt-3 max-w-sm text-sm leading-relaxed text-secondary-400">
          {{ marketing?.tagline }}
        </p>
      </div>
    </div>
  </div>
</template>
