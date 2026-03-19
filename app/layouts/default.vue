<template>
  <div class="flex h-screen overflow-hidden bg-white dark:bg-secondary-950">
    <!-- Sidebar (client-only to avoid SSR hydration mismatch with auth state) -->
    <ClientOnly>
      <OrganismsAppSidebar class="hidden md:flex" />
    </ClientOnly>

    <!-- Main content -->
    <main class="flex-1 overflow-y-auto">
      <slot />
    </main>
  </div>
</template>
