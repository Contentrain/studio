/**
 * Media variant preset definitions.
 *
 * Presets are referenced by name in model field configs:
 *   { "cover": { "type": "image", "variants": "hero-image" } }
 *
 * Custom variant configs override presets:
 *   { "cover": { "type": "image", "variants": { "hero": { "width": 1920, ... } } } }
 */

import type { VariantConfig } from '../providers/media'

export const VARIANT_PRESETS: Record<string, Record<string, VariantConfig>> = {
  'hero-image': {
    hero: { width: 1920, height: 1080, fit: 'cover', quality: 85 },
    card: { width: 600, height: 400, fit: 'cover', quality: 80 },
    thumb: { width: 300, height: 200, fit: 'cover', quality: 75 },
    og: { width: 1200, height: 630, fit: 'cover', quality: 90, format: 'jpeg' },
  },
  'avatar': {
    large: { width: 256, height: 256, fit: 'cover', quality: 90 },
    medium: { width: 96, height: 96, fit: 'cover', quality: 85 },
    small: { width: 48, height: 48, fit: 'cover', quality: 80 },
  },
  'gallery': {
    full: { width: 1600, height: 1200, fit: 'inside', quality: 85 },
    medium: { width: 800, height: 600, fit: 'inside', quality: 80 },
    thumb: { width: 200, height: 200, fit: 'cover', quality: 75 },
  },
  'icon': {
    default: { width: 128, height: 128, fit: 'contain', quality: 90 },
    small: { width: 48, height: 48, fit: 'contain', quality: 85 },
    tiny: { width: 24, height: 24, fit: 'contain', quality: 80 },
  },
  'logo': {
    default: { width: 400, fit: 'inside', quality: 90 },
    small: { width: 200, fit: 'inside', quality: 85 },
    favicon: { width: 32, height: 32, fit: 'contain', quality: 90, format: 'png' },
  },
}

/** Default preset when no variant config is specified on a field. */
export const DEFAULT_PRESET = 'hero-image'

/** Max dimensions for any uploaded image (Sharp memory safety). */
export const MAX_IMAGE_DIMENSION = 16384

/** Max original dimension after optimization (larger images are downscaled). */
export const MAX_ORIGINAL_DIMENSION = 4096

/**
 * Resolve variant config for a field.
 * - String → preset name lookup
 * - Object → custom config (passthrough)
 * - undefined → default preset
 */
export function resolveVariantConfig(
  fieldVariants: string | Record<string, VariantConfig> | undefined,
): Record<string, VariantConfig> {
  if (!fieldVariants)
    return VARIANT_PRESETS[DEFAULT_PRESET]!

  if (typeof fieldVariants === 'string')
    return VARIANT_PRESETS[fieldVariants] ?? VARIANT_PRESETS[DEFAULT_PRESET]!

  return fieldVariants
}

/**
 * Resolve variant config with plan enforcement.
 *
 * Gating:
 * - Custom variant objects require `media.custom_variants` (Pro+ in
 *   the default matrix). Plans that lack the feature fall back to the
 *   DEFAULT_PRESET so the upload still succeeds — we don't 403 on
 *   variant choice, we just refuse the customisation.
 * - The total number of variants per field is capped by
 *   `media.variants_per_field`. Exceeding the cap throws 403 (this
 *   always signals intent; silently truncating the set would surprise
 *   callers).
 *
 * Accepts the current plan + a `hasFeature` / `getPlanLimit` pair
 * (kept as injected closures to avoid a circular import from the
 * license util — media-variants.ts is also consumed by client
 * bundlers via conversation-engine.ts).
 */
export interface VariantPlanGate {
  hasCustomVariants: boolean
  variantsPerFieldLimit: number
}

export function resolveVariantConfigWithPlan(
  fieldVariants: string | Record<string, VariantConfig> | undefined,
  gate: VariantPlanGate,
): Record<string, VariantConfig> {
  // Custom config → require the feature; otherwise fall through to the
  // default preset. The plan matrix marks `media.custom_variants` as
  // `requires_ee: true`, so Community Edition always lands here.
  const resolved = (typeof fieldVariants === 'object' && fieldVariants !== null && !gate.hasCustomVariants)
    ? VARIANT_PRESETS[DEFAULT_PRESET]!
    : resolveVariantConfig(fieldVariants)

  // Limit check runs on the resolved set — a preset with more
  // variants than the plan allows is also caught here.
  if (gate.variantsPerFieldLimit > 0 && Object.keys(resolved).length > gate.variantsPerFieldLimit) {
    throw createError({
      statusCode: 403,
      message: 'Variant count exceeds your plan limit. Upgrade your plan or reduce the variant set.',
      data: { limit: gate.variantsPerFieldLimit, requested: Object.keys(resolved).length },
    })
  }

  return resolved
}

/**
 * MIME types allowed for media upload.
 */
export const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'application/pdf',
])

/**
 * Check if a MIME type is allowed for upload.
 */
export function isAllowedMimeType(contentType: string): boolean {
  return ALLOWED_MIME_TYPES.has(contentType)
}
