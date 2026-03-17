import { createAuthSigner } from './auth.js'

/**
 * Multi-node synchronization for overlay entries.
 *
 * Per BRC-88, when a SHIP/SLAP token is admitted on one overlay node,
 * it should be propagated to peer overlay nodes. Sync requests are
 * authenticated with the overlay's identity key signature.
 */
export class OverlaySync {
  /**
   * @param {object} opts
   * @param {string[]} opts.peerUrls — list of peer overlay node base URLs
   * @param {PrivateKey} [opts.identityKey] — for signing sync requests
   * @param {number} [opts.timeoutMs=10000]
   */
  constructor ({ peerUrls = [], identityKey = null, timeoutMs = 10000 } = {}) {
    this._peers = peerUrls.map(u => u.replace(/\/$/, ''))
    this._timeout = timeoutMs
    this._signer = identityKey ? createAuthSigner(identityKey) : null
  }

  get peerCount () {
    return this._peers.length
  }

  /**
   * Propagate a newly admitted SHIP token to all peer overlay nodes.
   * Best-effort — failures are logged, not thrown.
   *
   * @param {string} txHex — the transaction containing the SHIP token
   * @param {number} outputIndex — which output was admitted
   * @returns {Promise<{succeeded: number, failed: number, errors: string[]}>}
   */
  async propagateSubmit (txHex, outputIndex) {
    if (this._peers.length === 0) return { succeeded: 0, failed: 0, errors: [] }

    const results = await Promise.allSettled(
      this._peers.map(peerUrl => this._submitToPeer(peerUrl, txHex, outputIndex))
    )

    let succeeded = 0
    let failed = 0
    const errors = []

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.ok) {
        succeeded++
      } else {
        failed++
        const reason = result.status === 'rejected'
          ? result.reason?.message || 'unknown'
          : result.value?.error || `HTTP ${result.value?.status}`
        errors.push(reason)
      }
    }

    return { succeeded, failed, errors }
  }

  /**
   * Propagate a revocation to all peer overlay nodes.
   * @param {string} spendingTxHex
   * @param {string} spentTxid
   * @param {number} spentOutputIndex
   * @returns {Promise<{succeeded: number, failed: number, errors: string[]}>}
   */
  async propagateRevoke (spendingTxHex, spentTxid, spentOutputIndex) {
    if (this._peers.length === 0) return { succeeded: 0, failed: 0, errors: [] }

    const results = await Promise.allSettled(
      this._peers.map(peerUrl => this._revokeToPeer(peerUrl, spendingTxHex, spentTxid, spentOutputIndex))
    )

    let succeeded = 0
    let failed = 0
    const errors = []

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.ok) {
        succeeded++
      } else {
        failed++
        const reason = result.status === 'rejected'
          ? result.reason?.message || 'unknown'
          : result.value?.error || `HTTP ${result.value?.status}`
        errors.push(reason)
      }
    }

    return { succeeded, failed, errors }
  }

  async _submitToPeer (peerUrl, txHex, outputIndex) {
    const body = JSON.stringify({ rawTx: txHex, outputIndex })
    const headers = { 'Content-Type': 'application/json', 'x-overlay-sync': 'true' }
    if (this._signer) {
      headers['x-overlay-auth'] = this._signer.sign('POST', '/submit', body)
    }
    const res = await fetch(`${peerUrl}/submit`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this._timeout)
    })
    const data = await res.json()
    return { ok: res.ok && data.status === 'success', status: res.status, error: data.description }
  }

  async _revokeToPeer (peerUrl, spendingTxHex, spentTxid, spentOutputIndex) {
    const body = JSON.stringify({ spendingTxHex, spentTxid, spentOutputIndex })
    const headers = { 'Content-Type': 'application/json', 'x-overlay-sync': 'true' }
    if (this._signer) {
      headers['x-overlay-auth'] = this._signer.sign('POST', '/revoke', body)
    }
    const res = await fetch(`${peerUrl}/revoke`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this._timeout)
    })
    const data = await res.json()
    return { ok: res.ok && data.revoked !== undefined, status: res.status, error: data.reason }
  }
}
