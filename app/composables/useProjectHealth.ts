/**
 * Project Health — derived schema validation state for UI consumption.
 *
 * Reads schema validation results from Content Brain and exposes
 * computed health metrics: tier, severity counts, grouped warnings.
 */
export function useProjectHealth() {
  const brain = useContentBrain()

  const healthScore = computed(() => brain.schemaValidation.value?.healthScore ?? null)

  const healthTier = computed(() => {
    const score = healthScore.value
    if (score === null) return 'unavailable'
    if (score >= 90) return 'excellent'
    if (score >= 70) return 'good'
    if (score >= 50) return 'fair'
    return 'poor'
  })

  const warnings = computed(() => brain.schemaValidation.value?.warnings ?? [])
  const criticalCount = computed(() => warnings.value.filter(w => w.severity === 'critical').length)
  const errorCount = computed(() => warnings.value.filter(w => w.severity === 'error').length)
  const warningCount = computed(() => warnings.value.filter(w => w.severity === 'warning').length)

  const warningsByModel = computed(() => {
    const groups: Record<string, Array<typeof warnings.value[number]>> = {}
    for (const w of warnings.value) {
      if (!groups[w.modelId]) groups[w.modelId] = []
      groups[w.modelId]!.push(w)
    }
    return groups
  })

  const hasIssues = computed(() => criticalCount.value > 0 || errorCount.value > 0)

  return {
    healthScore,
    healthTier,
    warnings,
    criticalCount,
    errorCount,
    warningCount,
    warningsByModel,
    hasIssues,
  }
}
