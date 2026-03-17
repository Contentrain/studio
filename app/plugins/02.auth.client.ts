export default defineNuxtPlugin(async () => {
  const { init } = useAuth()
  await init()
})
