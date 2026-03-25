import { query } from '#contentrain'
import type { Starters } from '#contentrain'

/**
 * Access starter kit templates from Contentrain content.
 *
 * Starters are stored as a Contentrain collection (system/starters)
 * and loaded at build time via the generated SDK client.
 */
export function useStarters() {
  const starters = computed(() => query('starters').all())

  const featured = computed(() =>
    query('starters').where('featured', true).all(),
  )

  function byFramework(framework: Starters['framework']) {
    return query('starters').where('framework', framework).all()
  }

  function bySlug(slug: string) {
    return query('starters').where('slug', slug).first()
  }

  return {
    starters,
    featured,
    byFramework,
    bySlug,
  }
}
