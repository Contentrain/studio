<script setup lang="ts">
definePageMeta({
  layout: false,
})

const { t } = useContent()
const router = useRouter()
const route = useRoute()
const error = ref('')

onMounted(async () => {
  try {
    const code = route.query.code as string | undefined

    const hashParams = new URLSearchParams(window.location.hash.slice(1))
    const accessToken = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')

    if (code) {
      await $fetch('/api/auth/verify', {
        method: 'POST',
        body: { code },
      })
    }
    else if (accessToken) {
      await $fetch('/api/auth/verify', {
        method: 'POST',
        body: { accessToken, refreshToken },
      })
    }
    else {
      throw new Error(t('auth.failed'))
    }

    const { init } = useAuth()
    await init()
    await router.replace('/')
  }
  catch (e: unknown) {
    error.value = e instanceof Error ? e.message : t('auth.failed')
  }
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-white dark:bg-secondary-950">
    <div v-if="error" class="max-w-sm px-4 text-center">
      <p class="text-sm text-danger-600 dark:text-danger-400">
        {{ error }}
      </p>
      <NuxtLink
        to="/auth/login"
        class="mt-4 inline-block text-sm text-primary-500 hover:underline dark:text-primary-400"
      >
        {{ t('auth.back_to_login') }}
      </NuxtLink>
    </div>
    <div v-else class="text-center">
      <div class="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-secondary-200 dark:border-secondary-800 border-t-secondary-900 dark:border-t-secondary-100" />
      <p class="mt-3 text-sm text-muted">
        {{ t('auth.signing_in') }}
      </p>
    </div>
  </div>
</template>
