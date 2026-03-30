/**
 * Webhook retry scheduler — processes pending webhook deliveries on an interval.
 *
 * Runs every 60 seconds, picks up deliveries past their next_retry_at time,
 * and re-attempts delivery with exponential backoff.
 */
export default defineNitroPlugin((nitroApp) => {
  const interval = setInterval(async () => {
    try {
      await processWebhookRetries()
    }
    catch {
      // eslint-disable-next-line no-console
      console.error('[webhook] Retry processing failed')
    }
  }, 60_000)

  nitroApp.hooks.hook('close', () => {
    clearInterval(interval)
  })
})
