/**
 * Render content validation errors for the agent.
 *
 * MCP's validator attaches where an error was found (`entry`/`slug`, `field`,
 * `locale`) next to the message, but the message itself is often location-free
 * ("Required field is missing or empty"). Joining bare messages handed the
 * agent five identical lines it could not act on, so it guessed at causes and
 * re-sent whole payloads. Every rendered error now leads with its location.
 */
export interface LocatedValidationError {
  message: string
  entry?: string
  slug?: string
  field?: string
  locale?: string
}

export function formatValidationError(error: LocatedValidationError): string {
  const path = [error.entry ?? error.slug, error.field].filter(Boolean).join('.')
  const where = [path, error.locale ? `(${error.locale})` : ''].filter(Boolean).join(' ')
  return where ? `${where}: ${error.message}` : error.message
}

export function formatValidationErrors(errors: LocatedValidationError[], separator = '; '): string {
  return errors.map(e => formatValidationError(e)).join(separator)
}
