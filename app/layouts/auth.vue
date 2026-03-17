<script setup lang="ts">
const { t } = useContent()
const route = useRoute()

const isSignin = computed(() =>
  route.path.includes('login') || route.path.includes('forgot-password'),
)
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
    <div class="relative hidden w-0 flex-1 bg-[--color-surface] lg:block">
      <div class="flex h-full items-center justify-center px-16">
        <div class="max-w-md text-center">
          <h2 class="text-xl font-medium text-[--color-heading]">
            {{ isSignin ? t('auth.marketing_welcome') : t('auth.marketing_get_started') }}
          </h2>
          <p class="mt-2 text-sm text-[--color-text-muted]">
            {{ isSignin ? t('auth.marketing_signin_desc') : t('auth.marketing_signup_desc') }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
