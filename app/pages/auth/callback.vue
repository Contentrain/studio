<script setup lang="ts">
definePageMeta({
  layout: false,
})

const router = useRouter()
const error = ref('')

onMounted(async () => {
  const { $supabase } = useNuxtApp()
  const { data, error: authError } = await $supabase.auth.getSession()

  if (authError || !data.session) {
    error.value = authError?.message || 'Authentication failed'
    return
  }

  await router.replace('/')
})
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-white dark:bg-gray-950">
    <div v-if="error" class="text-center max-w-sm px-4">
      <div class="text-4xl mb-4">
        ⚠️
      </div>
      <p class="text-sm text-red-600 dark:text-red-400">
        {{ error }}
      </p>
      <NuxtLink
        to="/auth/login"
        class="mt-4 inline-block text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        Back to login
      </NuxtLink>
    </div>
    <div v-else class="text-center">
      <div class="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900 dark:border-gray-700 dark:border-t-gray-100 mx-auto" />
      <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
        Signing you in...
      </p>
    </div>
  </div>
</template>
