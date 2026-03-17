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
    <div class="hidden w-0 flex-1 flex-col overflow-hidden bg-secondary-900 lg:flex">
      <!-- Illustration: fills available space, min-h-0 prevents flex overflow -->
      <div class="flex min-h-0 flex-1 items-center justify-center p-10 pb-0">
        <NuxtImg
          v-if="marketing?.illustration"
          :src="marketing.illustration"
          alt=""
          class="max-h-full w-full object-contain"
          aria-hidden="true"
        />
      </div>
      <!-- Text: sits naturally below illustration -->
      <div class="shrink-0 px-12 pb-12 pt-8">
        <h2 class="text-xl font-semibold text-secondary-100">
          {{ marketing?.headline }}
        </h2>
        <p class="mt-2 max-w-md text-sm leading-relaxed text-secondary-400">
          {{ marketing?.tagline }}
        </p>
      </div>
    </div>
  </div>
</template>
