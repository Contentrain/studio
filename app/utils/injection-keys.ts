import type { ComputedRef, InjectionKey } from 'vue'

/**
 * Typed InjectionKeys for ContentPanel → child component communication.
 * Using Symbol-based keys provides compile-time type safety for inject().
 */

export const getFieldTypeKey: InjectionKey<(fieldId: string) => string> = Symbol('getFieldType')
export const getEntryTitleKey: InjectionKey<(entry: Record<string, unknown>, fallback: string) => string> = Symbol('getEntryTitle')
export const getUserFieldIdsKey: InjectionKey<() => string[]> = Symbol('getUserFieldIds')
export const activeModelMetaKey: InjectionKey<ComputedRef<{ id: string, name: string, kind: string } | null>> = Symbol('activeModelMeta')
export const getModelFieldsKey: InjectionKey<() => Record<string, unknown>> = Symbol('getModelFields')
export const sendChatPromptKey: InjectionKey<(text: string) => void> = Symbol('sendChatPrompt')

/**
 * Set by the app root to say a Radix `TooltipProvider` is already in the tree.
 *
 * Radix does not export its own provider-context inject, so `AtomsTooltip`
 * cannot ask it directly — and it must know, because `TooltipRoot` throws
 * without a provider while a nested one would defeat the point of hoisting.
 */
export const tooltipProviderKey: InjectionKey<true> = Symbol('tooltipProvider')
