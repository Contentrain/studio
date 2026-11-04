/**
 * Whether a project can use the media facet — one policy for every surface
 * that decides it: the MCP proxy (media identity headers, so the loopback
 * lists the media tools) and OAuth consent (whether a grant may carry
 * `media:*`). Requires the media stack (ee + R2), the plan's media feature,
 * project CDN delivery, and a workspace owner for `uploaded_by`.
 */
import type { Plan } from '~~/server/utils/license'
import { hasFeature } from '~~/server/utils/license'
import { useMediaProvider } from '~~/server/utils/providers'

export function projectMediaEligible(input: { plan: Plan, cdnEnabled: boolean, mediaOwnerId: string | null }): boolean {
  return useMediaProvider() !== null
    && hasFeature(input.plan, 'media.upload')
    && input.cdnEnabled
    && input.mediaOwnerId !== null
}
