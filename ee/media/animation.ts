/**
 * Animated GIF/WebP: what counts as animated, the bounds, and the rejections.
 *
 * sharp reads only the first frame unless `animated: true`, which used to turn every animated upload into a still.
 * An animation is kept whole, within `ANIMATION_LIMITS`, or the upload is refused with a message the customer can act on.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

import { createError } from 'h3'
import { ANIMATION_LIMITS } from '../../server/utils/media-variants'
import { errorMessage } from '../../server/utils/content-strings'

/** Frames of an image as sharp reports them by default (no `animated`): `pages`, absent for a still. */
export const frameCount = (pages: number | undefined): number => pages ?? 1

/** GIF and WebP are the formats sharp can read and write as animations. */
export const canAnimate = (contentType: string): boolean => contentType === 'image/gif' || contentType === 'image/webp'

/** Throws a 400 with a localised message when the animation is over a bound. `width`/`height` are one frame's. */
export function assertAnimationWithinLimits({ frames, width, height }: { frames: number, width: number, height: number }): void {
  if (frames > ANIMATION_LIMITS.maxFrames)
    throw createError({ statusCode: 400, message: errorMessage('media.animation_too_many_frames', { frames, limit: ANIMATION_LIMITS.maxFrames }) })
  const pixels = frames * width * height
  if (pixels > ANIMATION_LIMITS.maxTotalPixels)
    throw createError({ statusCode: 400, message: errorMessage('media.animation_too_large', { size: Math.ceil(pixels / 1_000_000), limit: ANIMATION_LIMITS.maxTotalPixels / 1_000_000 }) })
}

/** sharp's own error when `.timeout()` stops the pipeline: say so, in the customer's terms, instead of a bare 500. */
export function rethrowAnimationFailure(error: unknown): never {
  if (error instanceof Error && /time(d)? ?out/i.test(error.message))
    throw createError({ statusCode: 400, message: errorMessage('media.animation_timeout', { seconds: ANIMATION_LIMITS.timeoutSeconds }) })
  throw error
}
