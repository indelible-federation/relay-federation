import crypto from 'node:crypto'
import { Transaction, P2PKH, Hash, Utils } from '@bsv/sdk'
import { deriveChild } from '@relay-federation/common/derivation'
import { verifyTxBroadcast } from './chain.js'

/**
 * BRC-105 payment middleware for the overlay.
 *
 * Payment flow:
 *   1. Request arrives without payment → 402 with price + derivation prefix
 *   2. Server derives a payment address from its identity key using BRC-42
 *      with the derivation prefix as the invoice
 *   3. Client builds a tx paying to that address, sends with x-bsv-payment header
 *   4. Server re-derives the address, parses the tx, checks output pays correct amount
 *
 * The overlay's own WIF-based wallet handles verification — no external
 * wallet service needed. Same pattern as relay bridge registration payments.
 *
 * Verification includes:
 * - BRC-42 derived address check (correct payment destination)
 * - Amount verification (sufficient satoshis)
 * - Replay prevention (derivation prefix tracking with TTL)
 * - On-chain broadcast verification via WhatsOnChain
 */

// Track issued prefixes to prevent replay. Map<prefix, { satoshis, issuedAt, used }>
const _issuedPrefixes = new Map()
const PREFIX_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Create a payment verifier backed by the overlay's identity key.
 *
 * @param {PrivateKey} identityKey — the overlay's identity private key
 * @param {object} [opts]
 * @param {boolean} [opts.skipChainCheck=false] — skip on-chain broadcast verification (for testing)
 * @returns {function} verifyPayment — async (paymentData, satoshisRequired) => { valid, reason?, txid? }
 */
export function createPaymentVerifier (identityKey, { skipChainCheck = false } = {}) {
  return async function verifyPayment (paymentData, satoshisRequired) {
    const { derivationPrefix, derivationSuffix, transaction } = paymentData

    if (!derivationPrefix || !transaction) {
      return { valid: false, reason: 'missing derivationPrefix or transaction' }
    }

    // Check the prefix was issued by us and hasn't been used
    const issued = _issuedPrefixes.get(derivationPrefix)
    if (!issued) {
      return { valid: false, reason: 'unknown or expired derivation prefix' }
    }
    if (issued.used) {
      return { valid: false, reason: 'derivation prefix already consumed' }
    }
    if (Date.now() - issued.issuedAt > PREFIX_TTL_MS) {
      _issuedPrefixes.delete(derivationPrefix)
      return { valid: false, reason: 'derivation prefix expired' }
    }

    // Derive the expected payment address using BRC-42
    // Invoice format: derivation prefix as the invoice string
    const { childKey } = deriveChild(identityKey, derivationPrefix)
    const expectedAddress = childKey.toPublicKey().toAddress()

    // Parse the payment transaction
    let tx
    try {
      // BRC-105 specifies base64 AtomicBEEF, but also accept raw hex for simplicity
      const txHex = isHex(transaction) ? transaction : Buffer.from(transaction, 'base64').toString('hex')
      tx = Transaction.fromHex(txHex)
    } catch {
      return { valid: false, reason: 'cannot parse payment transaction' }
    }

    // Check outputs for payment to our derived address
    const p2pkh = new P2PKH()
    const expectedLockHex = p2pkh.lock(expectedAddress).toHex()
    let paidAmount = 0

    for (const output of tx.outputs) {
      const scriptHex = output.lockingScript?.toHex?.()
      if (scriptHex === expectedLockHex) {
        paidAmount += output.satoshis ?? 0
      }
    }

    if (paidAmount < satoshisRequired) {
      return {
        valid: false,
        reason: `insufficient payment: need ${satoshisRequired} sats, got ${paidAmount}`
      }
    }

    const txid = tx.id('hex')

    // Verify the payment tx is at least broadcast on-chain
    if (!skipChainCheck) {
      const chainStatus = await verifyTxBroadcast(txid)
      if (!chainStatus.valid) {
        return {
          valid: false,
          reason: chainStatus.reason || 'payment transaction not found on chain'
        }
      }
    }

    // Mark prefix as consumed
    issued.used = true

    return { valid: true, txid, paidAmount }
  }
}

/**
 * Create payment middleware for a specific endpoint.
 *
 * @param {object} opts
 * @param {number} opts.satoshis — price in satoshis (0 = free)
 * @param {string} [opts.description]
 * @param {function} [opts.verifyPayment] — from createPaymentVerifier()
 * @returns {function} middleware — async (req, res) => boolean
 */
export function createPaymentGate ({ satoshis, description = '', verifyPayment = null }) {
  return async function paymentGate (req, res) {
    if (satoshis <= 0) return true

    const paymentHeader = req.headers['x-bsv-payment']
    if (paymentHeader) {
      let paymentData
      try {
        paymentData = JSON.parse(paymentHeader)
      } catch {
        res.writeHead(400)
        res.end(JSON.stringify({
          status: 'error',
          code: 'ERR_INVALID_PAYMENT',
          description: 'x-bsv-payment header contains invalid JSON'
        }))
        return false
      }

      if (verifyPayment) {
        const result = await verifyPayment(paymentData, satoshis)
        if (result.valid) return true

        res.writeHead(402)
        res.end(JSON.stringify({
          status: 'error',
          code: 'ERR_PAYMENT_INVALID',
          description: result.reason || 'Payment verification failed'
        }))
        return false
      }

      // No verifier wired (identity key not loaded) — reject
      res.writeHead(500)
      res.end(JSON.stringify({
        status: 'error',
        code: 'ERR_NO_VERIFIER',
        description: 'Payment verification not configured on this node'
      }))
      return false
    }

    // No payment — return 402 with BRC-105 challenge
    const derivationPrefix = crypto.randomBytes(16).toString('base64')

    // Track the issued prefix for replay prevention
    _issuedPrefixes.set(derivationPrefix, { satoshis, issuedAt: Date.now(), used: false })

    // Periodic cleanup of expired prefixes
    if (_issuedPrefixes.size > 1000) {
      const now = Date.now()
      for (const [k, v] of _issuedPrefixes) {
        if (now - v.issuedAt > PREFIX_TTL_MS) _issuedPrefixes.delete(k)
      }
    }

    res.writeHead(402, {
      'x-bsv-payment-version': '1.0',
      'x-bsv-payment-satoshis-required': String(satoshis),
      'x-bsv-payment-derivation-prefix': derivationPrefix
    })
    res.end(JSON.stringify({
      status: 'payment_required',
      satoshisRequired: satoshis,
      derivationPrefix,
      description: description || `Payment of ${satoshis} satoshis required`
    }))
    return false
  }
}

/**
 * Load pricing configuration.
 * @param {object} [overrides] — explicit pricing values (takes precedence over env)
 * @returns {{ submit: number, lookup: number, revoke: number }}
 */
export function loadPricing (overrides = {}) {
  return {
    submit: overrides.submit ?? parseInt(process.env.OVERLAY_PRICE_SUBMIT || '0', 10),
    lookup: overrides.lookup ?? parseInt(process.env.OVERLAY_PRICE_LOOKUP || '0', 10),
    revoke: overrides.revoke ?? parseInt(process.env.OVERLAY_PRICE_REVOKE || '0', 10)
  }
}

/**
 * Clear issued prefixes (for testing).
 */
export function clearIssuedPrefixes () {
  _issuedPrefixes.clear()
}

function isHex (str) {
  return /^[0-9a-fA-F]+$/.test(str)
}
