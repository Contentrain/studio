/**
 * How long a tooltip waits.
 *
 * One definition, because there used to be three: `InfoTooltip` waited 200ms,
 * `ContentStatsBar` waited 300ms, and Radix's own default is 700ms. Which delay
 * you got depended on which component you happened to hover.
 */

/** First hover. Long enough not to fire while the pointer is passing through. */
export const TOOLTIP_DELAY_MS = 200

/**
 * How long after closing one tooltip the next opens with no delay at all.
 *
 * This is the reason the provider is hoisted to the app root: Radix only skips
 * the delay within a single provider, so with one provider per tooltip it never
 * applied. Scanning the three action icons on a row — the thing tooltips were
 * added for — used to cost the full delay three times.
 */
export const TOOLTIP_SKIP_DELAY_MS = 400
