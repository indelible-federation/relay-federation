/**
 * On-chain verification with relay bridge as primary, WoC as fallback.
 *
 * The local relay bridge at http://127.0.0.1:9333 has the header chain
 * and can verify transactions. WoC is used only if the bridge is unavailable.
 */

const BRIDGE_BASE = process.env.OVERLAY_BRIDGE_URL || 'http://127.0.0.1:9333'
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const DEFAULT_TIMEOUT = 15000

/**
 * Fetch transaction status — try relay bridge first, then WoC.
 * @param {string} txid
 * @returns {Promise<{exists: boolean, confirmed: boolean, confirmations: number, source: string}>}
 */
export async function getTxStatus (txid) {
  // Try relay bridge first
  const bridgeResult = await _getTxFromBridge(txid)
  if (bridgeResult.exists) return { ...bridgeResult, source: 'bridge' }

  // Fall back to WoC
  const wocResult = await _getTxFromWoc(txid)
  return { ...wocResult, source: wocResult.exists ? 'woc' : 'none' }
}

/**
 * Verify a transaction is at least broadcast (mempool or confirmed).
 * @param {string} txid
 * @returns {Promise<{valid: boolean, confirmed: boolean, source?: string, reason?: string}>}
 */
export async function verifyTxBroadcast (txid) {
  const status = await getTxStatus(txid)
  if (status.source === 'none') {
    return { valid: false, confirmed: false, reason: 'transaction_not_found' }
  }
  return { valid: true, confirmed: status.confirmed, source: status.source }
}

/**
 * Fetch raw transaction hex — try bridge first, then WoC.
 * @param {string} txid
 * @returns {Promise<string|null>}
 */
export async function getTxHex (txid) {
  // Try bridge
  try {
    const res = await fetch(`${BRIDGE_BASE}/tx/${txid}`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    })
    if (res.ok) {
      const data = await res.json()
      if (data.hex) return data.hex
    }
  } catch { /* fall through */ }

  // Fall back to WoC
  try {
    const res = await fetch(`${WOC_BASE}/tx/${txid}/hex`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    })
    if (res.ok) return await res.text()
  } catch { /* fall through */ }

  return null
}

// ── Internal: Bridge ──

async function _getTxFromBridge (txid) {
  try {
    const res = await fetch(`${BRIDGE_BASE}/tx/${txid}`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    })
    if (!res.ok) return { exists: false, confirmed: false, confirmations: 0 }
    const data = await res.json()
    // Bridge /tx/:txid returns tx data if known
    return {
      exists: true,
      confirmed: !!data.blockHash || !!data.blockhash,
      confirmations: data.confirmations || (data.blockHash ? 1 : 0)
    }
  } catch {
    return { exists: false, confirmed: false, confirmations: 0 }
  }
}

// ── Internal: WoC ──

async function _getTxFromWoc (txid) {
  try {
    const res = await fetch(`${WOC_BASE}/tx/${txid}`, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT)
    })
    if (!res.ok) return { exists: false, confirmed: false, confirmations: 0 }
    const data = await res.json()
    const confirmations = data.confirmations || 0
    return {
      exists: true,
      confirmed: confirmations > 0,
      confirmations
    }
  } catch {
    return { exists: false, confirmed: false, confirmations: 0 }
  }
}
