/**
 * Relay Directory Overlay Client.
 *
 * Lightweight client for querying the overlay from any app or bridge.
 * Can be imported as a module or used standalone.
 *
 * Usage:
 *   import { DirectoryClient } from './lib/client.js'
 *   const client = new DirectoryClient('http://vmi2946361.contaboserver.net:3360')
 *   const bridges = await client.findByTopic('oracle:rates:bsv')
 */
export class DirectoryClient {
  /**
   * @param {string} overlayUrl — base URL of the overlay node (e.g. 'http://localhost:3360')
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=10000]
   */
  constructor (overlayUrl, opts = {}) {
    this._url = overlayUrl.replace(/\/$/, '')
    this._timeout = opts.timeoutMs || 10000
  }

  /**
   * Find bridges that carry a specific topic.
   * @param {string} topic — e.g. 'oracle:rates:bsv'
   * @returns {Promise<Array<{txid, vout, satoshis, topic, domain, identityPubHex, lockingPubHex}>>}
   */
  async findByTopic (topic) {
    const data = await this._lookup({ topic })
    return data.outputs || []
  }

  /**
   * Find all topics a specific bridge carries.
   * @param {string} identityPubHex — bridge identity pubkey
   * @returns {Promise<Array<{txid, vout, satoshis, topic, domain, identityPubHex, lockingPubHex}>>}
   */
  async findByBridge (identityPubHex) {
    const data = await this._lookup({ bridge: identityPubHex })
    return data.outputs || []
  }

  /**
   * List all topics with advertiser counts.
   * @returns {Promise<Array<{topic, count}>>}
   */
  async listTopics () {
    const data = await this._lookup({ list: 'topics' })
    return data.results || []
  }

  /**
   * List all directory entries.
   * @returns {Promise<Array<{txid, vout, satoshis, topic, domain, identityPubHex, lockingPubHex}>>}
   */
  async listAll () {
    const data = await this._lookup({ list: 'all' })
    return data.outputs || []
  }

  /**
   * Check overlay health.
   * @returns {Promise<{service, status, topics, entries}>}
   */
  async status () {
    const res = await fetch(`${this._url}/status`, {
      signal: AbortSignal.timeout(this._timeout)
    })
    if (!res.ok) throw new Error(`Overlay status failed: HTTP ${res.status}`)
    return res.json()
  }

  /**
   * Submit a SHIP token to the overlay.
   * @param {string} txHex — transaction hex containing the SHIP token
   * @param {number} outputIndex — which output is the SHIP token
   * @returns {Promise<{status, topics}>}
   */
  async submit (txHex, outputIndex) {
    const res = await fetch(`${this._url}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx: txHex, outputIndex }),
      signal: AbortSignal.timeout(this._timeout)
    })
    if (res.status === 402) {
      const body = await res.json().catch(() => ({}))
      return {
        paymentRequired: true,
        satoshisRequired: parseInt(res.headers.get('x-bsv-payment-satoshis-required') || '0', 10),
        derivationPrefix: res.headers.get('x-bsv-payment-derivation-prefix'),
        ...body
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.description || `Submit failed: HTTP ${res.status}`)
    }
    return res.json()
  }

  /**
   * Revoke a SHIP token by providing the spending transaction.
   * @param {string} spendingTxHex
   * @param {string} spentTxid
   * @param {number} spentOutputIndex
   * @returns {Promise<{revoked: boolean}>}
   */
  async revoke (spendingTxHex, spentTxid, spentOutputIndex) {
    const res = await fetch(`${this._url}/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spendingTxHex, spentTxid, spentOutputIndex }),
      signal: AbortSignal.timeout(this._timeout)
    })
    if (res.status === 402) {
      const body = await res.json().catch(() => ({}))
      return {
        paymentRequired: true,
        satoshisRequired: parseInt(res.headers.get('x-bsv-payment-satoshis-required') || '0', 10),
        derivationPrefix: res.headers.get('x-bsv-payment-derivation-prefix'),
        ...body
      }
    }
    return res.json()
  }

  /**
   * Internal: POST /lookup with provider and query.
   * If the server returns 402, returns a payment challenge instead of throwing.
   */
  async _lookup (query) {
    const res = await fetch(`${this._url}/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'relay-topic-lookup', query }),
      signal: AbortSignal.timeout(this._timeout)
    })
    if (res.status === 402) {
      const body = await res.json().catch(() => ({}))
      return {
        paymentRequired: true,
        satoshisRequired: parseInt(res.headers.get('x-bsv-payment-satoshis-required') || '0', 10),
        derivationPrefix: res.headers.get('x-bsv-payment-derivation-prefix'),
        ...body
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.description || `Lookup failed: HTTP ${res.status}`)
    }
    return res.json()
  }
}
