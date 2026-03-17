<script setup lang="ts">
definePageMeta({
  layout: 'auth',
})

const { signInWithOAuth, signInWithMagicLink } = useAuth()

const showEmailForm = ref(false)
const email = ref('')
const magicLinkSent = ref(false)
const loading = ref(false)
const error = ref('')

async function handleOAuth(provider: 'github' | 'google') {
  loading.value = true
  error.value = ''
  try {
    await signInWithOAuth(provider)
  }
  catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Login failed'
    loading.value = false
  }
}

async function handleMagicLink() {
  if (!email.value)
    return

  loading.value = true
  error.value = ''
  try {
    await signInWithMagicLink(email.value)
    magicLinkSent.value = true
  }
  catch (e: unknown) {
    error.value = e instanceof Error ? e.message : 'Failed to send magic link'
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="flex flex-col">
    <AtomsHeadingText size="xl" :level="1">
      Welcome back<br>
      Sign in to your account
    </AtomsHeadingText>

    <!-- Error message -->
    <div
      v-if="error"
      class="mt-4 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 p-3 text-sm text-red-600 dark:text-red-400"
    >
      {{ error }}
    </div>

    <!-- Provider buttons (default view) -->
    <div v-if="!showEmailForm" class="mt-8">
      <MoleculesProviderButtons @provider="handleOAuth" />

      <!-- Email option -->
      <div class="mt-10 text-center">
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
          or sign in with your email
        </p>
        <AtomsGhostButton block size="md" @click="showEmailForm = true">
          Sign in with Email
        </AtomsGhostButton>
      </div>
    </div>

    <!-- Magic link form -->
    <div v-else class="mt-8">
      <div v-if="!magicLinkSent">
        <form class="space-y-4" @submit.prevent="handleMagicLink">
          <div>
            <label for="email" class="block text-sm font-medium text-gray-900 dark:text-gray-100">
              Email
            </label>
            <input
              id="email"
              v-model="email"
              type="email"
              required
              placeholder="you@example.com"
              autocomplete="email"
              class="mt-2 block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
          </div>
          <button
            type="submit"
            :disabled="loading || !email"
            class="w-full rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            Send magic link
          </button>
        </form>

        <!-- Back to providers -->
        <div class="mt-8 text-center">
          <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
            or sign in with providers
          </p>
          <MoleculesProviderButtons class="hidden lg:block" @provider="handleOAuth" />
          <MoleculesProviderButtons mobile @provider="handleOAuth" />
        </div>
      </div>

      <!-- Magic link sent confirmation -->
      <div v-else class="text-center py-8">
        <div class="text-4xl mb-4">
          ✉️
        </div>
        <p class="text-sm text-gray-600 dark:text-gray-300">
          We sent a login link to <strong class="text-gray-900 dark:text-gray-100">{{ email }}</strong>
        </p>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Check your inbox and click the link to sign in.
        </p>
        <button
          class="mt-4 text-sm text-blue-600 dark:text-blue-400 hover:underline"
          @click="magicLinkSent = false; email = ''"
        >
          Try a different email
        </button>
      </div>
    </div>

    <MoleculesAuthLink
      class="mt-auto pt-12"
      to="/auth/login"
      description="Need help getting started?"
      label="Contact support"
    />
  </div>
</template>
