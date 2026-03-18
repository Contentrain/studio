export default defineEventHandler(async (event) => {
  await clearServerSession(event)
  return { ok: true }
})
