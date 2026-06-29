import type { Sharp, SharpOptions } from 'sharp'

/**
 * Lazy `sharp` loader.
 *
 * `sharp` ships a native binary. Importing it eagerly at module top level
 * pulls that binary into the `ee/enterprise` import graph — and if the binary
 * fails to initialize on a given deploy (platform / libvips mismatch, musl vs
 * glibc, cold start, build-cache skew), the ENTIRE `import('ee/enterprise')`
 * rejects. `resolveDeployment` then reads the edition as `agpl` and, without
 * the degraded-mode guard, would downgrade every workspace to the fixed
 * `community` plan until the next redeploy. Loading sharp on first use keeps
 * the bridge import — and therefore plan/billing resolution — independent of
 * the native binary; only actual image processing depends on it.
 *
 * LICENSE: Proprietary — Contentrain Enterprise Edition
 */

// Minimal call signature for how the ee/media pipeline invokes sharp
// (a single buffer + options → pipeline). Named type imports are erased at
// compile time, so they do NOT trigger the native load.
type SharpFactory = (input?: Buffer, options?: SharpOptions) => Sharp

let _sharp: SharpFactory | null = null

export async function loadSharp(): Promise<SharpFactory> {
  if (!_sharp) {
    const mod = await import('sharp')
    // sharp uses `export =`; under esModuleInterop the callable lands on
    // `.default`, with the raw module as a fallback for non-interop bundlers.
    _sharp = ((mod as unknown as { default?: SharpFactory }).default ?? (mod as unknown as SharpFactory))
  }
  return _sharp
}
