/**
 * x402-middleware.js — HTTP 402 payment gate for relay federation bridges.
 *
 * Free reads, paid writes. Operator auth bypasses payment.
 * Design reviewed by Codex over 8 rounds (27+ security mitigations).
 *
 * Usage:
 *   const gate = createPaymentGate(config, store, fetchTx)
 *   const result = await gate(method, path, req)
 *   if (!result.ok) { res.writeHead(result.status, ...); res.end(...); return }
 */

import { addressToHash160 } from './output-parser.js'

const MAX_CONCURRENT = 50
const FETCH_TIMEOUT_MS = 5000
const TXID_RE = /^[0-9a-f]{64}$/i
const NEG_CACHE_MAX = 10000

// ── Helpers ──────────────────────────────────────────────

/**
 * Convert BSV decimal string to satoshis as BigInt. No floats.
 * @param {string|number} value — e.g. '0.00001000'
 * @returns {bigint}
 */
function bsvToSats (value) {
  const s = String(value)
  if (!/^\d+(\.\d{1,8})?$/.test(s)) throw new Error('bad_value')
  const [whole, frac = ''] = s.split('.')
  const fracPadded = (frac + '00000000').slice(0, 8)
  return BigInt(whole) * 100000000n + BigInt(fracPadded)
}

/**
 * Extract hash160 from a P2PKH locking script hex.
 * Returns null if not P2PKH.
 * @param {string} hex — locking script hex
 * @returns {string|null} 40-char hash160 hex or null
 */
function extractP2PKH (hex) {
  if (typeof hex !== 'string') return null
  if (hex.length === 50 && hex.startsWith('76a914') && hex.endsWith('88ac')) {
    return hex.slice(6, 46)
  }
  return null
}

/**
 * Get satoshis from a vout entry. Prefers integer fields over BSV decimals.
 * @param {object} v — vout entry from tx JSON
 * @returns {bigint}
 */
function getVoutSats (v) {
  // Prefer integer satoshi fields (no float conversion needed)
  if (v.valueSat !== undefined && v.valueSat !== null) return BigInt(v.valueSat)
  if (v.satoshis !== undefined && v.satoshis !== null) return BigInt(v.satoshis)
  // Fallback to BSV decimal
  if (v.value !== undefined && v.value !== null) return bsvToSats(v.value)
  return 0n
}

/**
 * Find P2PKH outputs paying the expected address. Sums all matching outputs.
 * @param {object} txJson — { vout: [{ value, scriptPubKey: { hex } }] }
 * @param {string} expectedHash160 — 40-char hex
 * @param {bigint} minSats — minimum required payment
 * @returns {{ ok: true, totalPaid: bigint, matched: Array } | null}
 */
function findPaymentOutput (txJson, expectedHash160, minSats) {
  let totalPaid = 0n
  const matched = []
  for (let i = 0; i < txJson.vout.length; i++) {
    const v = txJson.vout[i]
    const hash160 = extractP2PKH(v.scriptPubKey?.hex || '')
    if (!hash160) continue
    if (hash160 !== expectedHash160) continue
    const sats = getVoutSats(v)
    totalPaid += sats
    matched.push({ vout: i, sats: sats.toString() })
  }
  if (totalPaid >= minSats) return { ok: true, totalPaid, matched }
  return null
}

/**
 * Normalize a URL path: collapse double slashes, strip trailing slash,
 * decode segments, reject smuggled slashes.
 * Returns '/' for root path (never returns empty string).
 * @param {string} raw
 * @returns {string}
 */
export function normalizePath (raw) {
  const collapsed = raw.replace(/\/+/g, '/').replace(/\/$/, '')
  if (!collapsed) return '/'
  const segments = collapsed.split('/')
  const decoded = segments.map(seg => {
    try {
      const d = decodeURIComponent(seg)
      if (d.includes('/')) throw new Error('smuggled_slash')
      return d
    } catch { return seg }
  })
  return decoded.join('/') || '/'
}

/**
 * Build a route table from config endpoint keys and match against a path.
 * Supports parameterized patterns like /inscription/:txid/:vout/content.
 * @param {string} method — uppercased HTTP method
 * @param {string} path — normalized path
 * @param {Array} routes — pre-built route table
 * @returns {string|null} — matched route key or null
 */
function matchRoute (method, path, routes) {
  for (const route of routes) {
    if (route.method !== method) continue
    const routeParts = route.parts
    const pathParts = path.split('/')
    if (routeParts.length !== pathParts.length) continue
    const match = routeParts.every((part, i) =>
      part.startsWith(':') || part === pathParts[i]
    )
    if (match) return route.key
  }
  return null
}

/**
 * Wrap fetchTx with an AbortController timeout.
 * @param {function} fetchTx — async function(txid) → txJson
 * @param {string} txid
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
async function fetchTxWithTimeout (fetchTx, txid, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchTx(txid, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// ── Payment Gate Factory ─────────────────────────────────

/**
 * Create the x402 payment gate.
 *
 * @param {object} config — bridge config with x402 section
 * @param {object} store — PersistentStore instance (has claimTxid, releaseClaim, etc.)
 * @param {function} fetchTx — async function(txid, opts?) → { txid, vout: [...] }
 *   Must throw with { httpStatus } property to distinguish 404 vs upstream failure.
 * @returns {function} async checkPayment(method, rawPath, req) → result
 */
export function createPaymentGate (config, store, fetchTx) {
  const pricingMap = config.x402?.endpoints || {}
  const payTo = config.x402?.payTo || ''
  const enabled = !!(config.x402?.enabled && payTo)

  // Routes whose receipts are finalized as fulfilled:false until the handler delivers a
  // truthful answer (markFulfilled). An unfulfilled receipt is a standing credit — the
  // same payment txid may retry the SAME route + price.
  const fulfillmentAware = new Set(config.x402?.fulfillmentAware || [])

  const _pending = new Map() // txid → { promise, routeKey, price }
  const _negCache = new Map() // txid → { expiry, reason, status }

  // Build route table from config keys (once at startup)
  const routes = []
  let expectedHash160 = null

  if (enabled) {
    // Validate payTo — P2PKH only, fail fast
    expectedHash160 = addressToHash160(payTo)

    for (const [key, price] of Object.entries(pricingMap)) {
      if (!Number.isSafeInteger(price) || price < 0) {
        throw new Error(`[x402] Invalid price for ${key}: must be a non-negative integer`)
      }
      const colonIdx = key.indexOf(':')
      if (colonIdx === -1) {
        throw new Error(`[x402] Invalid endpoint key ${key}: must be METHOD:/path`)
      }
      const method = key.slice(0, colonIdx).toUpperCase()
      const pattern = key.slice(colonIdx + 1)
      if (!pattern.startsWith('/')) {
        throw new Error(`[x402] Invalid endpoint pattern ${pattern}: must start with /`)
      }
      routes.push({ method, pattern, parts: pattern.split('/'), key })
    }

    console.log(`[x402] Payment gate enabled: payTo=${payTo}, ${routes.length} paid endpoints`)
  }

  // ── Negative cache ──

  function isNegativelyCached (txid) {
    const entry = _negCache.get(txid)
    if (!entry) return null
    if (Date.now() > entry.expiry) { _negCache.delete(txid); return null }
    return entry
  }

  function cacheNegative (txid, reason, ttlMs, status) {
    const ttl = ttlMs || (reason === 'tx_not_found' ? 8000 : 60000)
    _negCache.set(txid, { expiry: Date.now() + ttl, reason, status: status || 402 })
    if (_negCache.size > NEG_CACHE_MAX) {
      const now = Date.now()
      // First pass: evict expired
      for (const [k, v] of _negCache) {
        if (now > v.expiry) _negCache.delete(k)
      }
      // Second pass: FIFO trim if still oversized
      if (_negCache.size > NEG_CACHE_MAX) {
        const excess = _negCache.size - NEG_CACHE_MAX
        let removed = 0
        for (const k of _negCache.keys()) {
          if (removed >= excess) break
          _negCache.delete(k)
          removed++
        }
      }
    }
  }

  // ── The gate function ──

  return async function checkPayment (method, rawPath, req) {
    if (!enabled) return { ok: true }

    method = method.toUpperCase()
    const path = normalizePath(rawPath)
    if (!path.startsWith('/')) return { ok: true }

    const routeKey = matchRoute(method, path, routes)
    if (!routeKey) return { ok: true }
    const price = pricingMap[routeKey] || 0
    if (price === 0) return { ok: true }

    // Normalize proof header (handle array, empty, whitespace)
    let proofRaw = req.headers['x-402-proof']
    if (Array.isArray(proofRaw)) proofRaw = proofRaw[0]
    if (!proofRaw || !proofRaw.trim()) {
      return {
        ok: false, status: 402,
        body: {
          x402Version: '1', scheme: 'bsv-direct', error: 'payment_required',
          endpoint: routeKey, satoshis: price,
          accepts: [{ scheme: 'bsv-direct', network: 'mainnet', satoshis: price, payTo }]
        }
      }
    }

    // Parse proof: accept <txid> or <txid>:<commit> (v2 stub)
    const proofStr = proofRaw.trim().toLowerCase().slice(0, 256)
    const txid = proofStr.split(':')[0]

    if (!TXID_RE.test(txid)) {
      return { ok: false, status: 400, body: { error: 'invalid_txid_format' } }
    }

    // Two-tier negative cache
    const cached = isNegativelyCached(txid)
    if (cached) {
      return { ok: false, status: cached.status, body: { error: cached.reason } }
    }

    // Cross-endpoint protection
    if (_pending.has(txid)) {
      const inflight = _pending.get(txid)
      if (inflight.routeKey !== routeKey || inflight.price !== price) {
        return { ok: false, status: 402, body: { error: 'already_used' } }
      }
      return await inflight.promise
    }

    // Cap concurrent verifications
    if (_pending.size >= MAX_CONCURRENT) {
      return { ok: false, status: 503, body: { error: 'too_many_verifications' } }
    }

    const verifyPromise = (async () => {
      // Atomic claim in LevelDB — put-if-absent (u!{txid} key)
      const claim = await store.claimTxid(txid, { routeKey, price, createdAt: Date.now() })
      if (!claim.ok) {
        // A finalized-but-UNFULFILLED receipt is a standing credit (the caller paid, our
        // backend failed to answer). Allow an idempotent retry for the SAME route at the
        // SAME price — payment was already verified; the key never left the store, so
        // replay protection is intact.
        if (typeof store.getPaymentReceipt === 'function') {
          const existing = await store.getPaymentReceipt(txid)
          if (existing && existing.status === 'receipt' && existing.fulfilled === false &&
              existing.endpointKey === routeKey && Number(existing.satoshisRequired) === Number(price)) {
            return { ok: true, receipt: existing, retry: true }
          }
        }
        return { ok: false, status: 402, body: { error: 'already_used' } }
      }

      try {
        // Fetch tx with timeout — distinguish 404 vs upstream failure
        let txJson
        try {
          txJson = await fetchTxWithTimeout(fetchTx, txid, FETCH_TIMEOUT_MS)
        } catch (err) {
          await store.releaseClaim(txid)
          // 404 = tx genuinely not found (short cache)
          // Anything else = upstream outage (don't punish user, very short cache)
          if (err.httpStatus === 404) {
            cacheNegative(txid, 'tx_not_found', 8000, 402)
            return { ok: false, status: 402, body: { error: 'tx_not_found' } }
          }
          cacheNegative(txid, 'upstream_unavailable', 3000, 503)
          return { ok: false, status: 503, body: { error: 'upstream_unavailable' } }
        }

        // Sanity checks
        const returnedId = txJson?.txid || txJson?.hash
        if (!returnedId || returnedId !== txid || !Array.isArray(txJson.vout) ||
            txJson.vout.length > 1000) {
          await store.releaseClaim(txid)
          cacheNegative(txid, 'invalid_payment', 60000, 402)
          return { ok: false, status: 402, body: { error: 'invalid_payment' } }
        }

        // Find P2PKH outputs paying our address
        const payment = findPaymentOutput(txJson, expectedHash160, BigInt(price))
        if (!payment) {
          await store.releaseClaim(txid)
          cacheNegative(txid, 'insufficient_payment', 60000, 402)
          return { ok: false, status: 402, body: { error: 'insufficient_payment' } }
        }

        // Promote claim to permanent receipt
        const receipt = {
          txid,
          satoshisRequired: String(price),
          satoshisPaid: payment.totalPaid.toString(),
          matchedVouts: payment.matched.map(m => m.vout),
          endpointKey: routeKey,
          createdAt: Date.now(),
          confirmed: false,
          confirmedHeight: null
        }
        // Fulfillment-aware routes start unfulfilled; the route handler calls markFulfilled()
        // once it delivers a truthful answer. Other routes keep legacy semantics (no fulfilled
        // field = fulfilled on payment).
        if (fulfillmentAware.has(routeKey)) receipt.fulfilled = false
        await store.finalizePayment(txid, receipt)
        return { ok: true, receipt }
      } catch (err) {
        // Safety net: release claim on ANY unexpected error (bad BigInt, store throw, etc.)
        await store.releaseClaim(txid).catch(() => {})
        console.error(`[x402] unexpected verify error for ${txid}:`, err)
        return { ok: false, status: 500, body: { error: 'internal_error' } }
      }
    })()

    _pending.set(txid, { promise: verifyPromise, routeKey, price })
    try {
      return await verifyPromise
    } finally {
      _pending.delete(txid)
    }
  }
}
