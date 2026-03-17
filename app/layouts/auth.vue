<script setup lang="ts">
import { singleton } from '#contentrain'

const marketing = singleton('auth-marketing').locale('en').get()
</script>

<template>
  <div class="flex min-h-screen">
    <!-- Left: Auth form -->
    <div class="flex flex-1 flex-col px-4 py-12 sm:px-6 lg:flex-none lg:px-20 xl:px-24">
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
    <div class="relative hidden w-0 flex-1 bg-secondary-50 dark:bg-secondary-900 lg:block">
      <div class="flex h-full flex-col items-center justify-center px-16">
        <div class="w-full max-w-md">
          <NuxtImg
            v-if="marketing?.illustration"
            :src="marketing.illustration"
            alt=""
            class="mb-10 w-full"
            aria-hidden="true"
          />
          <h2 class="text-xl font-semibold text-secondary-900 dark:text-secondary-100">
            {{ marketing?.headline }}
          </h2>
          <p class="mt-3 text-sm leading-relaxed text-body">
            {{ marketing?.tagline }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
