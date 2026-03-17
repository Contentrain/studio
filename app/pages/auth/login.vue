<script setup lang="ts">
definePageMeta({
  layout: 'auth',
})

const { signInWithOAuth, signInWithMagicLink } = useAuth()
const { t } = useContent()

const showEmailForm = ref(false)
const magicLinkSent = ref(false)
const sentEmail = ref('')
const loading = ref(false)
const error = ref('')

async function handleOAuth(provider: 'github' | 'google') {
  loading.value = true
  error.value = ''
  try {
    await signInWithOAuth(provider)
  }
  catch (e: unknown) {
    error.value = e instanceof Error ? e.message : t('auth.login_failed')
    loading.value = false
  }
}

async function handleMagicLink(email: string) {
  loading.value = true
  error.value = ''
  try {
    await signInWithMagicLink(email)
    sentEmail.value = email
    magicLinkSent.value = true
  }
  catch (e: unknown) {
    error.value = e instanceof Error ? e.message : t('auth.magic_link_failed')
  }
  finally {
    loading.value = false
  }
}

function resetEmailForm() {
  magicLinkSent.value = false
  sentEmail.value = ''
  error.value = ''
}
</script>

<template>
  <OrganismsSigninWithProvider
    v-if="!showEmailForm"
    @provider="handleOAuth"
    @show-email="showEmailForm = true"
  />
  <OrganismsSigninWithEmail
    v-else
    :loading="loading"
    :error="error"
    :magic-link-sent="magicLinkSent"
    :sent-email="sentEmail"
    @submit="handleMagicLink"
    @provider="handleOAuth"
    @reset="resetEmailForm"
  />
</template>
