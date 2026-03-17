import { createSupabaseAuthProvider } from '~~/server/providers/supabase-auth'

const authProvider = createSupabaseAuthProvider()

export default defineEventHandler(async (event) => {
  await authProvider.signOut(event)
  return { ok: true }
})
