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
