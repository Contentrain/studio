<script setup lang="ts">
export interface LogoProps {
  variant?: 'icon' | 'icon-text' | 'text'
  color?: 'color' | 'white' | 'dark' | 'auto'
}

const props = withDefaults(defineProps<LogoProps>(), {
  variant: 'icon-text',
  color: 'auto',
})

const variantMap = {
  'icon': { light: '/logo/icon-color.svg', dark: '/logo/icon-white.svg' },
  'icon-text': { light: '/logo/color-icon-black-text.svg', dark: '/logo/color-icon-white-text.svg' },
  'text': { light: '/logo/logo-text-dark.svg', dark: '/logo/logo-text-white.svg' },
}

const srcLight = computed(() => variantMap[props.variant].light)
const srcDark = computed(() => variantMap[props.variant].dark)

const resolvedSrc = computed(() => {
  switch (props.color) {
    case 'dark':
      return srcLight.value
    case 'white':
      return srcDark.value
    case 'color':
      return srcLight.value
    case 'auto':
    default:
      return undefined
  }
})
</script>

<template>
  <template v-if="color === 'auto'">
    <NuxtImg
      v-bind="$attrs"
      :src="srcLight"
      alt="Contentrain"
      class="block dark:hidden"
    />
    <NuxtImg
      v-bind="$attrs"
      :src="srcDark"
      alt="Contentrain"
      class="hidden dark:block"
    />
  </template>
  <NuxtImg
    v-else
    v-bind="$attrs"
    :src="resolvedSrc"
    alt="Contentrain"
  />
</template>
