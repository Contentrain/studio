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
