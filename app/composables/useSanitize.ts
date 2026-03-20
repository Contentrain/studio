import DOMPurify from 'dompurify'

/**
 * Sanitize HTML to prevent XSS in v-html bindings.
 * Uses DOMPurify with safe defaults — strips scripts, event handlers, and dangerous tags.
 */
export function useSanitize() {
  function sanitize(dirty: string): string {
    return DOMPurify.sanitize(dirty)
  }

  return { sanitize }
}
