import { PrivateKey, PublicKey, Hash } from '@bsv/sdk'

/**
 * BRC-42 key derivation helpers for the relay mesh.
 *
 * Uses the configured bridge WIF as the identity root and derives
 * protocol-specific child keys per BRC-43 invoice numbering.
 *
 * Derivation follows BRC-23/25/88:
 *   - counterparty: "anyone" (public key for scalar 1, i.e. generator point G)
 *   - invoice: <securityLevel>-<protocolID>-<keyID> per BRC-43
 *
 * Classification of invoice strings:
 *   - 2-SHIP-1: inferred from standards (BRC-23 publishes 2-CHIP-1, BRC-88 renames CHIP→SHIP)
 *   - 2-SLAP-1: inferred from standards (BRC-25 publishes 2-CLAP-1, BRC-88 renames CLAP→SLAP)
 *   - 2-relay-handshake-1: custom mesh-specific (no BRC defines this protocol ID)
 */

// BRC-42 "anyone" counterparty — public key for scalar 1 (generator point G)
const ANYONE_PUB = PublicKey.fromString('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
// "anyone" private key — scalar 1 (for public-side derivation)
const ANYONE_PRIV = new PrivateKey(1)

/**
 * Deterministic invoice constants for relay mesh protocols.
 */
export const INVOICES = Object.freeze({
  /** SHIP token locking key — inferred from BRC-23→88 rename (CHIP→SHIP) */
  SHIP: '2-SHIP-1',
  /** SLAP token locking key — inferred from BRC-25→88 rename (CLAP→SLAP) */
  SLAP: '2-SLAP-1',
  /** Wire handshake signing key — custom mesh-specific protocol */
  HANDSHAKE: '2-relay-handshake-1'
})

/**
 * Derive a child private key from an identity key using BRC-42.
 *
 * Uses the "anyone" counterparty (1×G) as specified in BRC-23/88.
 *
 * @param {PrivateKey} identityKey — master identity private key
 * @param {string} invoice — BRC-43 invoice string (e.g. INVOICES.SHIP)
 * @returns {{ childKey: PrivateKey, childPub: PublicKey, childPubHex: string }}
 */
export function deriveChild (identityKey, invoice) {
  const childKey = identityKey.deriveChild(ANYONE_PUB, invoice)
  const childPub = childKey.toPublicKey()
  return {
    childKey,
    childPub,
    childPubHex: childPub.toString()
  }
}

/**
 * Derive the public child key from an identity public key (for verification).
 * Anyone can compute this — no private key needed.
 *
 * @param {PublicKey} identityPub — master identity public key
 * @param {string} invoice — BRC-43 invoice string
 * @returns {PublicKey}
 */
export function deriveChildPub (identityPub, invoice) {
  return identityPub.deriveChild(ANYONE_PRIV, invoice)
}

/**
 * Sign data using a derived child key.
 *
 * Convenience: derives the child key and signs in one call.
 *
 * @param {string} dataHex — data to sign as hex string
 * @param {PrivateKey} identityKey — master identity private key
 * @param {string} invoice — BRC-43 invoice string
 * @returns {{ signature: string, childPubHex: string }}
 */
export function signWithDerived (dataHex, identityKey, invoice) {
  const { childKey, childPubHex } = deriveChild(identityKey, invoice)
  const hash = Hash.sha256(Buffer.from(dataHex, 'hex'))
  const sig = childKey.sign(hash)
  return {
    signature: sig.toDER('hex'),
    childPubHex
  }
}
