import { PrivateKey, PublicKey, Hash, Signature } from '@bsv/sdk'

/**
 * Request authentication for the overlay.
 *
 * Two modes:
 *   1. Peer sync auth: configured peers sign requests with their identity key.
 *      The receiving node verifies against its known peer pubkey list.
 *   2. Operator auth: the overlay operator signs requests with the overlay's
 *      own identity key (for /submit, /revoke from the CLI).
 *
 * Auth header format:
 *   x-overlay-auth: { "pubkey": "<hex>", "signature": "<hex>", "timestamp": <unix> }
 *
 * The signature covers: HTTP method + path + timestamp + body hash (SHA-256).
 * Timestamp must be within 5 minutes to prevent replay.
 */

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000 // 5 minutes
const NONCE_TTL_MS = 10 * 60 * 1000 // keep nonces for 10 minutes

/**
 * Create an auth signer for outbound requests.
 *
 * @param {PrivateKey} identityKey
 * @returns {{ sign: (method, path, body) => object }}
 */
export function createAuthSigner (identityKey) {
  const pubkeyHex = identityKey.toPublicKey().toString()

  return {
    /**
     * Generate auth header value for a request.
     * @param {string} method — HTTP method (POST, GET, etc.)
     * @param {string} path — request path (e.g. /submit)
     * @param {string} [body=''] — request body string
     * @returns {string} — JSON string for x-overlay-auth header
     */
    sign (method, path, body = '') {
      const timestamp = Math.floor(Date.now() / 1000)
      const bodyHash = Hash.sha256(Buffer.from(body || '', 'utf8')).toString('hex')
      const preimage = `${method.toUpperCase()}${path}${timestamp}${bodyHash}`
      const hash = Hash.sha256(Buffer.from(preimage, 'utf8'))
      const sig = identityKey.sign(hash)
      return JSON.stringify({
        pubkey: pubkeyHex,
        signature: sig.toDER('hex'),
        timestamp
      })
    }
  }
}

/**
 * Create an auth verifier for inbound requests.
 *
 * @param {object} opts
 * @param {Set<string>|string[]} opts.trustedPubkeys — set of trusted identity pubkey hexes
 * @returns {{ verify: (req, bodyString) => { valid, pubkey?, reason? } }}
 */
export function createAuthVerifier ({ trustedPubkeys }) {
  const trusted = trustedPubkeys instanceof Set
    ? trustedPubkeys
    : new Set(trustedPubkeys)
  const usedSignatures = new Map() // per-instance replay cache

  return {
    /**
     * Verify the x-overlay-auth header on an inbound request.
     *
     * @param {object} req — HTTP request (needs .method, .url, .headers)
     * @param {string} bodyString — raw body as string
     * @returns {{ valid: boolean, pubkey?: string, reason?: string }}
     */
    verify (req, bodyString) {
      const authHeader = req.headers['x-overlay-auth']
      if (!authHeader) {
        return { valid: false, reason: 'missing x-overlay-auth header' }
      }

      let auth
      try {
        auth = JSON.parse(authHeader)
      } catch {
        return { valid: false, reason: 'invalid x-overlay-auth JSON' }
      }

      const { pubkey, signature, timestamp } = auth
      if (!pubkey || !signature || !timestamp) {
        return { valid: false, reason: 'incomplete auth fields' }
      }

      // Check pubkey is trusted
      if (!trusted.has(pubkey)) {
        return { valid: false, reason: 'untrusted pubkey' }
      }

      // Check timestamp freshness
      const now = Math.floor(Date.now() / 1000)
      if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT_MS / 1000) {
        return { valid: false, reason: 'timestamp too old or too far in future' }
      }

      // Verify signature
      try {
        const url = new URL(req.url, `http://${req.headers.host}`)
        const path = url.pathname
        const bodyHash = Hash.sha256(Buffer.from(bodyString || '', 'utf8')).toString('hex')
        const preimage = `${req.method.toUpperCase()}${path}${timestamp}${bodyHash}`
        const hash = Hash.sha256(Buffer.from(preimage, 'utf8'))
        const sig = Signature.fromDER(signature, 'hex')
        const pub = PublicKey.fromString(pubkey)
        const valid = pub.verify(hash, sig)

        if (!valid) {
          return { valid: false, reason: 'signature verification failed' }
        }

        // Replay prevention: reject reused signatures (per-instance cache)
        if (usedSignatures.has(signature)) {
          return { valid: false, reason: 'replayed signature' }
        }
        usedSignatures.set(signature, Date.now())

        // Periodic cleanup of expired nonces
        if (usedSignatures.size > 1000) {
          const cutoff = Date.now() - NONCE_TTL_MS
          for (const [sig, ts] of usedSignatures) {
            if (ts < cutoff) usedSignatures.delete(sig)
          }
        }

        return { valid: true, pubkey }
      } catch (err) {
        return { valid: false, reason: `auth error: ${err.message}` }
      }
    }
  }
}

