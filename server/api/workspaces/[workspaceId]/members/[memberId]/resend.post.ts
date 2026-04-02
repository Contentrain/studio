/**
 * Resend a workspace invitation.
 *
 * For new users (invited via Supabase): re-sends the invite email.
 * For existing users: sends notification email via EmailProvider.
 * Rate limited to 3 resends per member per hour.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const db = useDatabaseProvider()
  const workspaceId = getRouterParam(event, 'workspaceId')
  const memberId = getRouterParam(event, 'memberId')

  if (!workspaceId || !memberId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_member_required') })

  // Rate limit: 3 resends per member per hour
  const rateCheck = checkRateLimit(`resend-invite:${memberId}`, 3, 60 * 60 * 1000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('members.resend_rate_limited') })

  // Fetch member
  const member = await db.getWorkspaceMember(session.accessToken, session.user.id, workspaceId, memberId)

  if (!member)
    throw createError({ statusCode: 404, message: errorMessage('members.not_found') })

  if ((member as { accepted_at?: string | null }).accepted_at)
    throw createError({ statusCode: 400, message: errorMessage('members.already_accepted') })

  const invitedEmail = (member as { invited_email?: string | null }).invited_email
  if (!invitedEmail)
    throw createError({ statusCode: 400, message: errorMessage('members.no_email') })

  // Get workspace info for email context
  const ws = await db.getWorkspaceForUser(session.accessToken, session.user.id, workspaceId, ['owner', 'admin'], 'name, slug')

  const authProvider = useAuthProvider()
  let emailSent = false

  try {
    // Try re-inviting via Supabase (works for users not yet confirmed)
    const config = useRuntimeConfig()
    await authProvider.inviteUserByEmail(invitedEmail, {
      redirectTo: `${config.public.siteUrl}/auth/callback?workspace=${ws?.slug ?? ''}`,
    })
    emailSent = true
  }
  catch {
    // User already confirmed — send notification via EmailProvider
    const emailProvider = useEmailProvider()
    if (emailProvider && ws) {
      const config = useRuntimeConfig()
      const workspaceUrl = `${config.public.siteUrl}/w/${ws.slug}`
      await emailProvider.sendEmail({
        to: invitedEmail,
        subject: `Reminder: You've been invited to ${ws.name} on Contentrain Studio`,
        html: `<p>Hi,</p><p>This is a reminder that you have a pending invitation to the <strong>${ws.name}</strong> workspace on Contentrain Studio.</p><p><a href="${workspaceUrl}">Open workspace</a></p>`,
      })
      emailSent = true
    }
  }

  if (!emailSent) {
    throw createError({ statusCode: 502, message: errorMessage('members.resend_failed') })
  }

  // Update invited_at only after successful email send
  await db.updateWorkspaceMemberInvitedAt(session.accessToken, session.user.id, workspaceId, memberId, new Date().toISOString())

  return { resent: true }
})
