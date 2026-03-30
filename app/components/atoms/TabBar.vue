<script setup lang="ts">
import { TabsIndicator, TabsList, TabsRoot, TabsTrigger } from 'radix-vue'

const modelValue = defineModel<string>({ required: true })

defineProps<{
  tabs: Array<{ value: string, label: string }>
}>()
</script>

<template>
  <TabsRoot v-model="modelValue">
    <TabsList class="relative flex gap-1 border-b border-secondary-200 px-5 dark:border-secondary-800">
      <TabsTrigger
        v-for="tab in tabs"
        :key="tab.value"
        :value="tab.value"
        class="relative border-b-2 border-transparent px-3 py-2 text-xs font-medium text-muted transition-colors hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50 data-[state=active]:border-primary-500 data-[state=active]:text-primary-600 dark:data-[state=active]:text-primary-400"
      >
        {{ tab.label }}
      </TabsTrigger>
      <TabsIndicator class="absolute bottom-0 left-0 h-0.5 rounded-full bg-primary-500 transition-all duration-200" />
    </TabsList>
  </TabsRoot>
</template>
