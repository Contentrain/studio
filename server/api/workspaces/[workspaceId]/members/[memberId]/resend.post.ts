/**
 * Resend a workspace invitation.
 *
 * For new users (invited via Supabase): re-sends the invite email.
 * For existing users: sends notification email via EmailProvider.
 * Rate limited to 3 resends per member per hour.
 */
export default defineEventHandler(async (event) => {
  const session = requireAuth(event)
  const workspaceId = getRouterParam(event, 'workspaceId')
  const memberId = getRouterParam(event, 'memberId')

  if (!workspaceId || !memberId)
    throw createError({ statusCode: 400, message: errorMessage('validation.workspace_member_required') })

  const client = useSupabaseUserClient(session.accessToken)
  await requireWorkspaceRole(client, session.user.id, workspaceId, ['owner', 'admin'])

  // Rate limit: 3 resends per member per hour
  const rateCheck = checkRateLimit(`resend-invite:${memberId}`, 3, 60 * 60 * 1000)
  if (!rateCheck.allowed)
    throw createError({ statusCode: 429, message: errorMessage('members.resend_rate_limited') })

  const admin = useSupabaseAdmin()

  // Fetch member
  const { data: member } = await admin
    .from('workspace_members')
    .select('id, user_id, role, invited_email, accepted_at')
    .eq('id', memberId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!member)
    throw createError({ statusCode: 404, message: errorMessage('members.not_found') })

  if (member.accepted_at)
    throw createError({ statusCode: 400, message: errorMessage('members.already_accepted') })

  if (!member.invited_email)
    throw createError({ statusCode: 400, message: errorMessage('members.no_email') })

  // Get workspace info for email context
  const { data: ws } = await admin
    .from('workspaces')
    .select('name, slug')
    .eq('id', workspaceId)
    .single()

  const authProvider = useAuthProvider()

  try {
    // Try re-inviting via Supabase (works for users not yet confirmed)
    const config = useRuntimeConfig()
    await authProvider.inviteUserByEmail(member.invited_email, {
      redirectTo: `${config.public.siteUrl}/auth/callback?workspace=${ws?.slug ?? ''}`,
    })
  }
  catch {
    // User already confirmed — send notification via EmailProvider
    const emailProvider = useEmailProvider()
    if (emailProvider && ws) {
      const config = useRuntimeConfig()
      const workspaceUrl = `${config.public.siteUrl}/w/${ws.slug}`
      await emailProvider.sendEmail({
        to: member.invited_email,
        subject: `Reminder: You've been invited to ${ws.name} on Contentrain Studio`,
        html: `<p>Hi,</p><p>This is a reminder that you have a pending invitation to the <strong>${ws.name}</strong> workspace on Contentrain Studio.</p><p><a href="${workspaceUrl}">Open workspace</a></p>`,
      })
    }
  }

  // Update invited_at to reset timestamp
  await admin
    .from('workspace_members')
    .update({ invited_at: new Date().toISOString() })
    .eq('id', memberId)

  return { resent: true }
})
