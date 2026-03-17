<script lang="ts" setup>
interface Props {
  loading: boolean
  error: string
  magicLinkSent: boolean
  sentEmail: string
}

defineProps<Props>()

defineEmits<{
  submit: [email: string]
  provider: [provider: 'github' | 'google']
  reset: []
}>()

const { t } = useContent()
const email = ref('')
</script>

<template>
  <div class="flex flex-col">
    <AtomsHeadingText size="xl" :level="1">
      {{ t('auth.welcome_back') }}<br>
      {{ t('auth.sign_in_title') }}
    </AtomsHeadingText>

    <!-- Error -->
    <div
      v-if="error"
      class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-900 dark:bg-red-950/50 dark:text-red-400"
    >
      {{ error }}
    </div>

    <!-- Email form -->
    <div v-if="!magicLinkSent" class="mt-6">
      <form class="space-y-4" @submit.prevent="$emit('submit', email)">
        <div>
          <label for="email" class="block text-sm font-medium text-gray-900 dark:text-gray-100">
            {{ t('auth.email_label') }}
          </label>
          <input
            id="email"
            v-model="email"
            type="email"
            required
            :placeholder="t('auth.email_placeholder')"
            autocomplete="email"
            class="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
          >
        </div>
        <button
          type="submit"
          :disabled="loading || !email"
          class="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-800 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
        >
          {{ t('auth.send_magic_link') }}
        </button>
      </form>

      <!-- Provider buttons below -->
      <div class="mt-10">
        <p class="mb-3 text-center text-sm text-gray-500 dark:text-gray-400">
          {{ t('auth.or_providers') }}
        </p>
        <MoleculesProviderButtons class="hidden lg:block" @provider="$emit('provider', $event)" />
        <MoleculesProviderButtons mobile @provider="$emit('provider', $event)" />
      </div>
    </div>

    <!-- Magic link sent -->
    <div v-else class="mt-8 py-8 text-center">
      <div class="mb-4 text-4xl">
        ✉️
      </div>
      <p class="text-sm text-gray-600 dark:text-gray-300">
        {{ t('auth.magic_link_sent_description') }}
        <strong class="text-gray-900 dark:text-gray-100">{{ sentEmail }}</strong>
      </p>
      <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
        {{ t('auth.magic_link_sent_instruction') }}
      </p>
      <button
        class="mt-4 text-sm text-blue-600 hover:underline dark:text-blue-400"
        @click="$emit('reset')"
      >
        {{ t('auth.try_different_email') }}
      </button>
    </div>

    <MoleculesAuthLink
      class="mt-auto pt-12"
      to="/auth/login"
      :description="t('auth.need_help')"
      :label="t('auth.contact_support')"
    />
  </div>
</template>
