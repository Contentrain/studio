export default defineEventHandler(async (event) => {
  // Managed pair: revoke the refresh-token family server-side so the pair
  // can never mint again. Best-effort — logout must always clear the cookie.
  try {
    const session = await getServerSession(event)
    if (session?.refreshToken)
      await useAuthProvider().revokeSession?.(session.refreshToken)
  }
  catch {
    // never block logout
  }

  await clearServerSession(event)
  return { ok: true }
})
