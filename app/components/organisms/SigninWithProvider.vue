<script lang="ts" setup>
const props = defineProps<{
  error?: string
}>()

defineEmits<{
  provider: [provider: 'github' | 'google']
  showEmail: []
}>()

const { t } = useContent()
</script>

<template>
  <div class="flex flex-col">
    <div>
      <AtomsHeadingText size="xl" :level="1">
        {{ t('auth.welcome_back') }}<br>
        {{ t('auth.sign_in_title') }}
      </AtomsHeadingText>

      <p v-if="props.error" class="mt-4 text-sm text-danger-600 dark:text-danger-400">
        {{ props.error }}
      </p>

      <MoleculesProviderButtons class="mt-8" @provider="$emit('provider', $event)" />

      <MoleculesEmailButton
        :description="t('auth.or_email')"
        :label="t('auth.sign_in_email')"
        @click="$emit('showEmail')"
      />
    </div>

    <MoleculesAuthLink
      class="mt-auto pt-12"
      to="/auth/login"
      :description="t('auth.need_help')"
      :label="t('auth.contact_support')"
    />
  </div>
</template>
