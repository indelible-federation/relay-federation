import { EventEmitter } from 'node:events'

/**
 * TxRelay — relays transactions between peers.
 *
 * Uses the INV/GETDATA pattern (like Bitcoin P2P):
 * 1. Peer announces a txid via tx_announce
 * 2. If we haven't seen it, we request the full tx via tx_request
 * 3. Peer responds with the raw tx hex via tx message
 * 4. We store it and re-announce to other peers
 *
 * Message types:
 *   tx_announce   — { type, txid }
 *   tx_request    — { type, txid }
 *   tx            — { type, txid, rawHex }
 *   tx_confirmed  — { type, txid, source, bsvPeers, bridge, ts }
 *
 * Events:
 *   'tx:new'       — { txid, rawHex } — new transaction received or submitted
 *   'tx:confirmed' — { txid, source, bsvPeers, bridge, ts } — remote bridge confirmed broadcast
 */
export class TxRelay extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {object} [opts]
   * @param {number} [opts.maxMempool=1000] — Max txs in local mempool
   */
  constructor (peerManager, opts = {}) {
    super()
    this.peerManager = peerManager
    this.bridgeName = opts.bridgeName || 'unknown'
    /** @type {Map<string, string>} txid → rawHex */
    this.mempool = new Map()
    /** @type {Set<string>} txids we've already seen (dedup) */
    this.seen = new Set()
    this._maxMempool = opts.maxMempool || 1000
    this._seenMax = opts.maxSeen || 50000

    /** @type {Map<string, number>} txid → timestamp first seen via BSV P2P inv */
    this.knownTxids = new Map()
    this._knownTxidMax = opts.maxKnownTxids || 10000
    this._knownTxidTtlMs = opts.knownTxidTtlMs || 600000 // 10 min

    // g-345 origin-tag / selective fetch. Mesh tx announces carry an origin:
    //   'broadcast'  — a real federation write (explicit broadcastTx callers)
    //   'p2p-relay'  — global-mempool chatter observed from BSV P2P
    //   (absent)     — an older mesh member that doesn't tag ('untagged')
    // With selectiveFetch ON (indexer-backed bridges), only 'broadcast'-tagged
    // announces get their bodies requested; chatter/untagged announces are
    // tracked as seen but never downloaded — so one self-sufficient mesh member
    // can't re-import the whole mempool firehose into indexer-backed boxes.
    // Self-sufficient bridges (default) fetch everything, as always.
    this._selectiveFetch = opts.selectiveFetch ?? false
    /** @type {Map<string, string>} txid → origin (for faithful re-announce) */
    this.txOrigins = new Map()
    this._txOriginMax = opts.maxTxOrigins || 50000
    /** @type {Set<string>} txids we've already sent a tx_request for (pack attack 2:
     *  the fetch-decision is split from seen-dedup so a later 'broadcast' announce
     *  can rescue a txid first seen as chatter; this set bounds re-requests). */
    this._requestedTxids = new Set()
    this._requestedMax = opts.maxRequested || 50000

    /** @type {Map<string, Array>} txid → array of confirmation reports from other bridges */
    this.confirmations = new Map()
    this._confirmMax = 5000
    this._confirmTtlMs = 120000 // 2 min — short-lived, just for the broadcast response window

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._handleMessage(pubkeyHex, message)
    })
  }

  /**
   * Submit a new tx for relay to all peers.
   * @param {string} txid
   * @param {string} rawHex
   * @returns {number} Number of peers the announce was sent to
   */
  broadcastTx (txid, rawHex, origin = 'broadcast') {
    if (this.seen.has(txid)) return 0
    this._trackSeen(txid)
    this._storeTx(txid, rawHex)
    this._trackOrigin(txid, origin)
    this.emit('tx:new', { txid, rawHex })
    return this.peerManager.broadcast({ type: 'tx_announce', txid, origin })
  }

  /**
   * Toggle selective fetch (g-345). Set true on indexer-backed bridges so only
   * 'broadcast'-origin announces are downloaded. Settable after construction
   * because the operating mode is resolved later in startup than TxRelay.
   * @param {boolean} v
   */
  setSelectiveFetch (v) {
    this._selectiveFetch = !!v
  }

  /**
   * Get a tx from the local mempool.
   * @param {string} txid
   * @returns {string|null} rawHex or null
   */
  getTx (txid) {
    return this.mempool.get(txid) || null
  }

  /**
   * Record a txid as "seen on the BSV network" without storing the full tx.
   * @param {string} txid
   */
  trackTxid (txid) {
    if (this.knownTxids.has(txid)) return
    // LRU eviction: when at capacity, delete oldest entry
    if (this.knownTxids.size >= this._knownTxidMax) {
      const oldest = this.knownTxids.keys().next().value
      this.knownTxids.delete(oldest)
    }
    this.knownTxids.set(txid, Date.now())
  }

  /**
   * Check if we've seen a txid on the network (inv or mempool).
   * @param {string} txid
   * @returns {boolean}
   */
  hasSeen (txid) {
    return this.seen.has(txid) || this.knownTxids.has(txid)
  }

  /**
   * Report that THIS bridge confirmed a tx to BSV miners.
   * Gossips the confirmation to all mesh peers so the originator can collect the aggregate.
   * @param {string} txid
   * @param {string} source — 'p2p', 'arc', or 'woc'
   * @param {number} bsvPeers — number of BSV P2P peers that accepted
   */
  confirmTx (txid, source, bsvPeers = 0) {
    const report = { txid, source, bsvPeers, bridge: this.bridgeName, ts: Date.now() }
    this._storeConfirmation(txid, report)
    this.peerManager.broadcast({ type: 'tx_confirmed', ...report })
  }

  /**
   * Get all confirmation reports for a txid (local + remote).
   * @param {string} txid
   * @returns {{ bridges: number, totalBsvPeers: number, confirmations: Array }}
   */
  getConfirmations (txid) {
    const reports = this.confirmations.get(txid) || []
    let totalBsvPeers = 0
    for (const r of reports) totalBsvPeers += r.bsvPeers || 0
    return {
      bridges: reports.length,
      totalBsvPeers,
      confirmations: reports
    }
  }

  /** @private — remember a txid's announce origin with LRU eviction (g-345) */
  _trackOrigin (txid, origin) {
    if (!origin) return
    if (this.txOrigins.size >= this._txOriginMax) {
      this.txOrigins.delete(this.txOrigins.keys().next().value)
    }
    this.txOrigins.set(txid, origin)
  }

  /** @private — add txid to seen set with LRU eviction */
  _trackSeen (txid) {
    if (this.seen.has(txid)) return
    if (this.seen.size >= this._seenMax) {
      this.seen.delete(this.seen.values().next().value)
    }
    this.seen.add(txid)
  }

  /** @private */
  _storeTx (txid, rawHex) {
    if (this.mempool.size >= this._maxMempool) {
      const oldest = this.mempool.keys().next().value
      this.mempool.delete(oldest)
    }
    this.mempool.set(txid, rawHex)
  }

  /** @private — store a confirmation report with LRU eviction */
  _storeConfirmation (txid, report) {
    if (!this.confirmations.has(txid)) {
      if (this.confirmations.size >= this._confirmMax) {
        const oldest = this.confirmations.keys().next().value
        this.confirmations.delete(oldest)
      }
      this.confirmations.set(txid, [])
    }
    const arr = this.confirmations.get(txid)
    // Dedup by bridge name
    if (!arr.some(r => r.bridge === report.bridge)) {
      arr.push(report)
    }
  }

  /** @private */
  _handleMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'tx_announce':
        this._onTxAnnounce(pubkeyHex, message)
        break
      case 'tx_request':
        this._onTxRequest(pubkeyHex, message)
        break
      case 'tx':
        this._onTx(pubkeyHex, message)
        break
      case 'tx_confirmed':
        this._onTxConfirmed(pubkeyHex, message)
        break
    }
  }

  /** @private */
  _onTxAnnounce (pubkeyHex, msg) {
    const origin = msg.origin || 'untagged'
    this._trackOrigin(msg.txid, origin)
    const alreadySeen = this.seen.has(msg.txid)
    if (!alreadySeen) this._trackSeen(msg.txid)
    if (this.mempool.has(msg.txid)) return // already hold the body
    if (this._selectiveFetch) {
      // g-345 selective fetch: only download the bodies of real federation
      // writes. Chatter ('p2p-relay') and announces from older non-tagging
      // members ('untagged') are tracked, never fetched. The fetch decision is
      // deliberately split from seen-dedup (pack attack 2): a 'broadcast'
      // announce for a txid first seen as chatter still gets fetched —
      // _requestedTxids bounds this to one tx_request per txid.
      if (origin !== 'broadcast') return
      if (this._requestedTxids.has(msg.txid)) return
    } else if (alreadySeen) {
      return // classic dedup — self-sufficient behavior unchanged
    }
    this._trackRequested(msg.txid)
    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({ type: 'tx_request', txid: msg.txid })
    }
  }

  /** @private — remember that we've requested this txid (LRU-capped) */
  _trackRequested (txid) {
    if (this._requestedTxids.size >= this._requestedMax) {
      this._requestedTxids.delete(this._requestedTxids.values().next().value)
    }
    this._requestedTxids.add(txid)
  }

  /** @private */
  _onTxRequest (pubkeyHex, msg) {
    const rawHex = this.mempool.get(msg.txid)
    if (rawHex) {
      const conn = this.peerManager.peers.get(pubkeyHex)
      if (conn) {
        // Include the origin so the requester can re-announce it faithfully
        conn.send({ type: 'tx', txid: msg.txid, rawHex, origin: this.txOrigins.get(msg.txid) })
      }
    }
  }

  /** @private */
  _onTx (pubkeyHex, msg) {
    if (!msg.txid || !msg.rawHex) return
    if (this.mempool.has(msg.txid)) return
    this._storeTx(msg.txid, msg.rawHex)
    const origin = msg.origin || this.txOrigins.get(msg.txid)
    this._trackOrigin(msg.txid, origin)
    this.emit('tx:new', { txid: msg.txid, rawHex: msg.rawHex })
    // Re-announce to all peers except the source — preserving the origin tag
    // (never upgrade chatter to 'broadcast'; absent stays absent)
    const announce = { type: 'tx_announce', txid: msg.txid }
    if (origin && origin !== 'untagged') announce.origin = origin
    this.peerManager.broadcast(announce, pubkeyHex)
  }

  /** @private — remote bridge confirmed a tx broadcast */
  _onTxConfirmed (pubkeyHex, msg) {
    if (!msg.txid) return
    const report = {
      txid: msg.txid,
      source: msg.source || 'unknown',
      bsvPeers: msg.bsvPeers || 0,
      bridge: msg.bridge || pubkeyHex.slice(0, 16),
      ts: msg.ts || Date.now()
    }
    this._storeConfirmation(msg.txid, report)
    this.emit('tx:confirmed', report)
  }
}
