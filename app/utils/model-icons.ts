/**
 * Map model kind to Annon icon class.
 * Used consistently across sidebar and context panel.
 */
export function getModelKindIcon(kind: string): string {
  const map: Record<string, string> = {
    singleton: 'icon-[annon--file]',
    collection: 'icon-[annon--list-unordered]',
    document: 'icon-[annon--file-text]',
    dictionary: 'icon-[annon--book-library]',
  }
  return map[kind] ?? 'icon-[annon--file]'
}
