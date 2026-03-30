/**
 * Initialize optional EE (Enterprise Edition) modules.
 *
 * Runs once when Nitro starts — loads EE providers via dynamic import.
 * If ee/ directory is absent (core-only build), all EE features
 * gracefully degrade to null.
 */
export default defineNitroPlugin(async () => {
  await initMediaProvider()
})
