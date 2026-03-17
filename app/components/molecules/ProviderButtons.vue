<script lang="ts" setup>
interface Props {
  mobile?: boolean
}

withDefaults(defineProps<Props>(), {
  mobile: false,
})

defineEmits<{
  provider: [provider: 'github' | 'google']
}>()
</script>

<template>
  <div :class="mobile ? 'flex gap-2 lg:hidden' : 'space-y-3'">
    <AtomsGhostButton block size="md" @click="$emit('provider', 'github')">
      <template #prepend>
        <svg class="h-5 w-5" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M10 0C4.478 0 0 4.478 0 10c0 4.418 2.865 8.167 6.839 9.489.5.092.682-.217.682-.482v-1.691c-2.782.607-3.369-1.343-3.369-1.343-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.532 1.032 1.532 1.032.892 1.53 2.341 1.088 2.912.832.09-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.921.678 1.856v2.752c0 .268.18.58.688.482C17.137 18.163 20 14.418 20 10c0-5.522-4.478-10-10-10z"
            class="fill-gray-900 dark:fill-gray-100"
          />
        </svg>
      </template>
      <span v-if="!mobile">Continue with GitHub</span>
    </AtomsGhostButton>

    <AtomsGhostButton block size="md" @click="$emit('provider', 'google')">
      <template #prepend>
        <svg class="h-5 w-5" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M10.204 8.182v3.873h5.492a5.06 5.06 0 01-2.2 3.318l3.312 2.518c1.93-1.745 3.128-4.509 3.128-7.555 0-.734-.065-1.416-.18-2.07L10.204 8.182z" fill="#4285F4" />
          <path d="M4.486 11.903A5.986 5.986 0 014.165 10c0-.664.118-1.3.326-1.9L1.095 5.518A9.98 9.98 0 000 10c0 1.618.399 3.136 1.095 4.482l3.39-2.579z" fill="#FBBC05" />
          <path d="M10.204 3.982c1.503 0 2.839.509 3.906 1.49l2.922-2.863C15.26.99 12.96 0 10.204 0 6.215 0 2.774 2.245 1.095 5.518l3.39 2.582c.808-2.364 3.062-4.118 5.719-4.118z" fill="#EA4335" />
          <path d="M4.486 11.903c-.807-2.36-3.062-4.118 5.718-4.118C7.55 16.027 5.297 14.273 4.49 11.909l-3.394 2.573C2.774 17.755 6.215 20 10.204 20c2.755 0 5.065-.982 6.753-2.664l-3.312-2.518c-.981.66-2.236 1.06-3.441 1.06-2.657 0-4.911-1.727-5.718-4.093v.118z" fill="#34A853" />
        </svg>
      </template>
      <span v-if="!mobile">Continue with Google</span>
    </AtomsGhostButton>
  </div>
</template>
