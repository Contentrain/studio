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
      class="mt-4 rounded-lg border border-danger-200 bg-danger-50 p-3 text-sm text-danger-600 dark:border-danger-900 dark:bg-danger-950/50 dark:text-danger-400"
    >
      {{ error }}
    </div>

    <!-- Email form -->
    <div v-if="!magicLinkSent" class="mt-6">
      <form class="space-y-4" @submit.prevent="$emit('submit', email)">
        <div>
          <AtomsFormLabel
            for="email"
            :text="t('auth.email_label')"
            size="sm"
            bold
          />
          <div class="mt-2">
            <AtomsFormInput
              id="email"
              v-model="email"
              type="email"
              name="email"
              required
              :placeholder="t('auth.email_placeholder')"
            />
          </div>
        </div>
        <!-- TODO: add AtomsFilledButton / AtomsPrimaryButton atom; using GhostButton with primary overrides for now -->
        <AtomsGhostButton
          type="submit"
          :disabled="loading || !email"
          block
          class="bg-primary-600 border-primary-600 text-white hover:bg-primary-700 dark:bg-primary-500 dark:border-primary-500 dark:hover:bg-primary-400 dark:text-white"
        >
          {{ t('auth.send_magic_link') }}
        </AtomsGhostButton>
      </form>

      <!-- Provider buttons below -->
      <div class="mt-10">
        <p class="mb-3 text-center text-sm text-muted">
          {{ t('auth.or_providers') }}
        </p>
        <MoleculesProviderButtons class="hidden lg:block" @provider="$emit('provider', $event)" />
        <MoleculesProviderButtons mobile @provider="$emit('provider', $event)" />
      </div>
    </div>

    <!-- Magic link sent -->
    <div v-else class="mt-8 py-8 text-center">
      <span class="icon-[annon--email] text-primary-500 text-4xl mb-4" />
      <p class="text-sm text-secondary-600 dark:text-secondary-300">
        {{ t('auth.magic_link_sent_description') }}
        <strong class="text-secondary-900 dark:text-secondary-100">{{ sentEmail }}</strong>
      </p>
      <p class="mt-2 text-sm text-muted">
        {{ t('auth.magic_link_sent_instruction') }}
      </p>
      <button
        class="mt-4 text-sm text-primary-500 hover:underline dark:text-primary-400"
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
