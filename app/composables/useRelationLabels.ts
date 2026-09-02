import type { Ref } from 'vue'
import { buildRelationOptions, isPolymorphicRelation } from '~~/shared/utils/content-relations'

/**
 * Per relation field, the label of every entry it can point at, keyed the way
 * the stored value keys them (`relationItemKey`: the ref, or `model::ref` for
 * a polymorphic compound).
 */
export type RelationLabelMap = Record<string, Record<string, string>>

interface RelationModel {
  readonly id: string
  readonly fields?: Record<string, unknown> | Readonly<Record<string, unknown>> | null
}

/**
 * What a relation value is called.
 *
 * The edit form resolved relation refs to titles and the read view printed
 * them raw, so an editor's first sight of every record was a wall of hex —
 * they opened the modal just to learn what a row pointed at, then cancelled.
 * Both surfaces, and the filter axes, now read from this one map, built with
 * the same `buildRelationOptions` the picker uses, so a relation cannot be
 * titled one way in the form and another in the row beneath it.
 *
 * Loaded from the Content Brain once per model, locale and synced tree — not
 * per row. A non-i18n target is stored under the default locale only, so that
 * is tried when the active locale has nothing.
 */
export function useRelationLabels(model: Ref<RelationModel | null | undefined>, locale: Ref<string>) {
  const brain = useContentBrain()
  const relationLabels = ref<RelationLabelMap>({})
  let loadToken = 0

  async function load() {
    const token = ++loadToken
    const fields = (model.value?.fields ?? {}) as Record<string, { type?: string, model?: string | string[] }>
    const defaultLocale = (brain.config.value as { locales?: { default?: string } } | null)?.locales?.default
    const next: RelationLabelMap = {}

    for (const [fieldId, def] of Object.entries(fields)) {
      if (def?.type !== 'relation' && def?.type !== 'relations') continue
      const targets = Array.isArray(def.model) ? def.model : def.model ? [def.model] : []
      const polymorphic = isPolymorphicRelation(def.model)
      const labels: Record<string, string> = {}

      for (const targetId of targets) {
        let result = await brain.queryContent(targetId, locale.value)
        if (!result?.data && defaultLocale && defaultLocale !== locale.value)
          result = await brain.queryContent(targetId, defaultLocale)
        const targetModel = brain.models.value.find(m => m.id === targetId) ?? null
        for (const option of buildRelationOptions(targetId, result?.data, polymorphic, targetModel))
          labels[option.value] = option.label
      }

      if (Object.keys(labels).length > 0) next[fieldId] = labels
    }

    // A slower load for the previous model must not land on top of this one.
    if (token === loadToken) relationLabels.value = next
  }

  // The tree sha moves on every sync, which is when a renamed target entry
  // should start showing its new title.
  watch(() => [model.value?.id, locale.value, brain.treeSha.value], () => {
    relationLabels.value = {}
    void load()
  }, { immediate: true })

  return { relationLabels, reload: load }
}
