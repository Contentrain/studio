import slugifyLib from 'slugify'

export function slugify(input: string): string {
  return slugifyLib(input, { lower: true, strict: true, trim: true })
}

export function validateSlug(slug: string): { valid: boolean, error?: string } {
  if (slug.length < 2) return { valid: false, error: 'Slug must be at least 2 characters' }
  if (slug.length > 48) return { valid: false, error: 'Slug must be less than 48 characters' }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug)) return { valid: false, error: 'Slug can only contain lowercase letters, numbers, and hyphens' }
  return { valid: true }
}
