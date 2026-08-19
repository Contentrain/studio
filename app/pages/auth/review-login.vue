<script setup lang="ts">
/**
 * Directory-review password login — /auth/review-login.
 *
 * Companion page for the env-gated review account (see
 * server/api/auth/review-login.post.ts). Reviewers get this URL plus the
 * credentials in the submission portal's test-account instructions. On
 * deployments without the env opt-in the POST 404s and the page shows the
 * generic failure message — nothing about the surface is discoverable.
 */
definePageMeta({
  layout: 'auth',
  auth: false,
})

const { t } = useContent()

useHead({ title: () => t('review_login.title') })

const email = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

async function handleSubmit() {
  if (!email.value.trim() || !password.value) return
  loading.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/review-login', {
      method: 'POST',
      body: { email: email.value.trim(), password: password.value },
    })
    const { init } = useAuth()
    await init()
    await navigateTo('/')
  }
  catch (e: unknown) {
    error.value = resolveApiError(e, t('review_login.failed'))
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-sm">
    <AtomsHeadingText tag="h1" size="lg">
      {{ t('review_login.title') }}
    </AtomsHeadingText>
    <p class="mt-1 text-sm text-muted">
      {{ t('review_login.description') }}
    </p>

    <form class="mt-6 space-y-4" @submit.prevent="handleSubmit">
      <div>
        <AtomsFormLabel for="review-email" :text="t('review_login.email_label')" size="sm" />
        <AtomsFormInput
          id="review-email"
          v-model="email"
          type="email"
          autocomplete="username"
          class="mt-1.5"
        />
      </div>
      <div>
        <AtomsFormLabel for="review-password" :text="t('review_login.password_label')" size="sm" />
        <AtomsFormInput
          id="review-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="mt-1.5"
        />
      </div>

      <p v-if="error" class="text-sm text-danger-600 dark:text-danger-400">
        {{ error }}
      </p>

      <AtomsBaseButton type="submit" variant="primary" block :disabled="loading || !email.trim() || !password">
        {{ loading ? t('review_login.signing_in') : t('review_login.submit') }}
      </AtomsBaseButton>
    </form>
  </div>
</template>
