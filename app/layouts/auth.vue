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
    <div class="relative hidden w-0 flex-1 overflow-hidden bg-secondary-900 lg:block">
      <!-- Illustration fills the panel -->
      <div class="absolute inset-0 flex items-center justify-center p-10 pb-36">
        <NuxtImg
          v-if="marketing?.illustration"
          :src="marketing.illustration"
          alt=""
          class="h-full w-full object-contain"
          aria-hidden="true"
        />
      </div>
      <!-- Text pinned to bottom with gradient -->
      <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-secondary-900 via-secondary-900/80 to-transparent px-12 pb-12 pt-20">
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
