import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * AES-256-GCM encryption for BYOA API keys.
 * Uses the session secret as the encryption key.
 *
 * Versioned format: "v{version}:{base64(iv:12 + authTag:16 + ciphertext)}"
 * Legacy format (v0): plain base64 without version prefix.
 *
 * Versioning ensures that secret rotation can be detected and migrated
 * rather than silently producing decryption failures.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const CURRENT_VERSION = 1

function deriveKey(secret: string): Buffer {
  // Derive 32 bytes for AES-256 using SHA-256 (deterministic KDF)
  // This ensures consistent key length regardless of input secret length
  return createHash('sha256').update(secret).digest()
}

export function encryptApiKey(plaintext: string, secret: string): string {
  const key = deriveKey(secret)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  // Pack: iv + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted])
  return `v${CURRENT_VERSION}:${packed.toString('base64')}`
}

/**
 * Parse versioned ciphertext. Returns version number and raw base64 payload.
 * Legacy (unversioned) ciphertexts are treated as v0.
 */
function parseVersioned(encrypted: string): { version: number, payload: string } {
  const match = encrypted.match(/^v(\d+):(.+)$/)
  if (match) {
    return { version: Number.parseInt(match[1]!, 10), payload: match[2]! }
  }
  return { version: 0, payload: encrypted }
}

export function decryptApiKey(encrypted: string, secret: string): string {
  const { payload } = parseVersioned(encrypted)
  const key = deriveKey(secret)
  const packed = Buffer.from(payload, 'base64')

  const iv = packed.subarray(0, IV_LENGTH)
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])

  return decrypted.toString('utf-8')
}

/**
 * Check if a ciphertext needs re-encryption (e.g., after secret rotation
 * or format upgrade). Returns true if the version is older than current.
 */
export function needsReEncryption(encrypted: string): boolean {
  const { version } = parseVersioned(encrypted)
  return version < CURRENT_VERSION
}

/**
 * Get last 4 characters of an API key for display hint.
 * e.g., "sk-ant-api03-...abcd"
 */
export function getKeyHint(plaintext: string): string {
  if (plaintext.length <= 4) return '****'
  return `...${plaintext.slice(-4)}`
}
