import os from 'node:os'
import { createServer } from 'node:http'
import { isIP } from 'node:net'
import dns from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { parseTx, addressToHash160 } from './output-parser.js'
import { scanAddress } from './address-scanner.js'
import { handlePostData, handleGetTopics, handleGetData } from './data-endpoints.js'
import { createPaymentGate } from './x402-middleware.js'
import { handleWellKnownX402 } from './x402-endpoints.js'

// ARC returns HTTP 200 + a txid all through its lifecycle — including QUEUED/RECEIVED/STORED (not on
// the network yet) and ANNOUNCED_TO_NETWORK/REQUESTED_BY_NETWORK (ARC sent an INV / a node asked for
// it, but no node has actually taken the tx). res.ok is NOT acceptance. Count a broadcast as relayed
// only once a node actually has the tx: SENT_TO_NETWORK (sent to >=1 node), ACCEPTED_BY_NETWORK,
// SEEN_ON_NETWORK, or MINED. ARC is only a fallback here (P2P/our node first, WhatsOnChain after), so
// being strict is free — a merely-announced tx falls through to the next path instead of being
// falsely marked sent.
const ARC_NETWORK_STATUSES = new Set(['SENT_TO_NETWORK', 'ACCEPTED_BY_NETWORK', 'SEEN_ON_NETWORK', 'MINED'])

// True only if ARC's body reports a real network status (never on res.ok alone — STORED leaks through).
export async function arcRelayed (arcRes) {
  if (!arcRes || !arcRes.ok) return false
  const d = await arcRes.json().catch(() => null)
  return !!(d && ARC_NETWORK_STATUSES.has(d.txStatus))
}

// Raw-tx hex is ~2x the tx byte size; broadcast routes accept a larger body than control routes.
const STATUS_BROADCAST_MAX_BYTES = 24 * 1024 * 1024
const BROADCAST_RATE_MAX = 30          // requests per IP
const BROADCAST_RATE_WINDOW_MS = 60_000

// ARC / node / WoC "already known" phrasings — a duplicate broadcast is a SUCCESS, not a failure
// (a false 502 here makes a client rebuild a tx on the same inputs → real double-spends).
const TX_ALREADY_KNOWN_RE = /transaction already in the (mempool|block ?chain)|already in the (mempool|block ?chain)|txn-already-in-mempool|txn-already-known/i

// SSRF guard for /mesh/proxy: reject private / loopback / link-local / ULA / CGNAT / multicast /
// unspecified targets (v4 + v6). The mesh proxies READ-ONLY bridge endpoints, which are public IPs —
// nothing legitimate resolves into these ranges.
function isBlockedIp (ip) {
  const a = String(ip).replace(/^::ffff:/i, '')
  const kind = isIP(a)
  if (kind === 4) {
    const o = a.split('.').map(Number)
    if (o.length !== 4 || o.some(n => !Number.isInteger(n))) return true
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true
    if (o[0] === 169 && o[1] === 254) return true            // link-local
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true // RFC1918
    if (o[0] === 192 && o[1] === 168) return true            // RFC1918
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true // CGNAT
    if (o[0] >= 224) return true                             // multicast / reserved
    return false
  }
  if (kind === 6) {
    const lo = a.toLowerCase()
    // Allow ONLY global-unicast 2000::/3 (first hextet 2 or 3); block ::1, ::, link-local
    // fe80::/10, ULA fc00::/7, multicast, etc.
    if (!/^[23]/.test(lo)) return true
    // 6to4 and Teredo live INSIDE global unicast and tunnel an embedded IPv4, so a
    // 2002:7f00:1:: / 2001:0::7f00:1 can reach private space — block both.
    if (lo.startsWith('2002:')) return true   // 6to4 (2002::/16)
    if (/^2001:0*:/.test(lo)) return true     // Teredo (2001:0::/32)
    return false
  }
  return true // not a valid IP literal → block
}

/**
 * StatusServer — public-facing HTTP server exposing bridge status and APIs.
 *
 * Started by `relay-bridge start`, queried by `relay-bridge status`.
 * Binds to 0.0.0.0 — accessible from outside the machine.
 * Operator-only endpoints are gated by statusSecret authentication.
 *
 * Endpoints:
 *   GET  /             — HTML dashboard (auto-refreshes every 5s)
 *   GET  /status       — JSON object with bridge state
 *   GET  /discover     — Known bridges in the mesh
 *   POST /broadcast    — Relay a raw transaction
 *   POST /data         — Submit a signed data envelope
 *   GET  /data/topics  — List topics with cached data
 *   GET  /data/:topic  — Query cached envelopes by topic
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_HTML = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8')
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version
// The operator dashboard holds the statusSecret, so keep executable JS same-origin.
// script-src 'self' means no third-party CDN can run code in this origin (three.js is vendored to /vendor/).
// 'unsafe-inline' stays for now because the dashboard is inline-script/handler heavy; connect-src allows
// http(s) so the multi-bridge mesh view still reaches operator-configured bridge URLs.
const DASHBOARD_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
export class StatusServer {
  /**
   * @param {object} opts
   * @param {number} [opts.port=9333] — HTTP port for status endpoint
   * @param {import('./peer-manager.js').PeerManager} [opts.peerManager]
   * @param {import('./header-relay.js').HeaderRelay} [opts.headerRelay]
   * @param {import('./tx-relay.js').TxRelay} [opts.txRelay]
   * @param {object} [opts.config] — Bridge config (pubkeyHex, endpoint, meshId)
   * @param {object} [opts.bsvNodeClient] — BSV P2P node client (2.26)
   * @param {object} [opts.store] — PersistentStore for wallet balance (2.27)
   * @param {object} [opts.addressWatcher] — AddressWatcher for local UTXO tracking
   */
  constructor (opts = {}) {
    this._port = opts.port || 9333
    this._peerManager = opts.peerManager || null
    this._headerRelay = opts.headerRelay || null
    this._txRelay = opts.txRelay || null
    this._dataRelay = opts.dataRelay || null
    this._config = opts.config || {}
    this._scorer = opts.scorer || null
    this._peerHealth = opts.peerHealth || null
    this._bsvNodeClient = opts.bsvNodeClient || null
    this._teranodeClient = opts.teranodeClient || null
    this._store = opts.store || null
    this._addressWatcher = opts.addressWatcher || null
    this._performOutboundHandshake = opts.performOutboundHandshake || null
    this._registeredPubkeys = opts.registeredPubkeys || null
    this._gossipManager = opts.gossipManager || null
    this._startedAt = Date.now()
    this._server = null

    // Cleanup lifecycle (g-Gamma-flap-fix 2026-05-04):
    // _isShuttingDown is checked inside cleanup() to break out of the for-await
    // loop immediately on shutdown. _activeCleanup tracks the in-flight promise
    // so stop() can await it before letting the caller close the LevelDB.
    this._isShuttingDown = false
    this._activeCleanup = null
    this._txCleanupInterval = null

    // Job system for async actions (register, deregister)
    this._jobs = new Map()
    this._jobCounter = 0

    // Log ring buffer — max 500 entries
    this._logs = []
    this._logListeners = new Set()
    this._maxLogs = 500

    // App monitoring state
    this._appChecks = new Map()
    this._requestTracker = new Map()
    this._appSSLCache = new Map()
    this._appBridgeDomains = new Set()
    this._appCheckInterval = null
    this._addressCache = new Map()
    if (this._config.apps) {
      for (const app of this._config.apps) {
        this._appChecks.set(app.url, { checks: [], lastError: null })
        if (app.bridgeDomain) {
          this._appBridgeDomains.add(app.bridgeDomain)
          this._requestTracker.set(app.bridgeDomain, { total: 0, endpoints: {}, lastSeen: null })
        }
        try { this._appBridgeDomains.add(new URL(app.url).hostname) } catch {}
      }
    }

    // x402 payment gate
    this._paymentGate = null
    if (this._config.x402?.enabled && this._config.x402?.payTo && this._store) {
      try {
        const fetchTx = async (txid, opts) => {
          // Check mempool first
          if (this._txRelay?.mempool.has(txid)) {
            const raw = this._txRelay.mempool.get(txid)
            const p = parseTx(raw)
            return { txid: p.txid, vout: p.outputs.map(o => ({ satoshis: o.satoshis, scriptPubKey: { hex: o.scriptHex } })) }
          }
          // Try BSV P2P
          if (this._bsvNodeClient) {
            try {
              const { rawHex } = await this._bsvNodeClient.getTx(txid, 5000)
              const p = parseTx(rawHex)
              return { txid: p.txid, vout: p.outputs.map(o => ({ satoshis: o.satoshis, scriptPubKey: { hex: o.scriptHex } })) }
            } catch {}
          }
          // WoC fallback
          const resp = await fetch(
            `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`,
            { signal: opts?.signal || AbortSignal.timeout(5000) }
          )
          if (!resp.ok) {
            const err = new Error(`WoC ${resp.status}`)
            err.httpStatus = resp.status
            throw err
          }
          return await resp.json()
        }
        this._paymentGate = createPaymentGate(this._config, this._store, fetchTx)
        this._store.cleanupStaleClaims().catch(() => {})
      } catch (err) {
        console.error('[x402] Failed to create payment gate:', err.message)
      }
    }
  }

  /**
   * Build the status object from current bridge state.
   * @param {object} [opts]
   * @param {boolean} [opts.authenticated=false] — Include operator-only fields
   * @returns {Promise<object>}
   */
  async getStatus ({ authenticated = false } = {}) {
    const peers = []
    if (this._peerManager) {
      for (const [pubkeyHex, conn] of this._peerManager.peers) {
        const entry = {
          pubkeyHex,
          endpoint: conn.endpoint,
          connected: !!conn.connected
        }
        if (this._scorer) {
          entry.score = Math.round(this._scorer.getScore(pubkeyHex) * 100) / 100
          const metrics = this._scorer.getMetrics(pubkeyHex)
          if (metrics) {
            entry.scoreBreakdown = {
              uptime: Math.round(metrics.uptime * 100) / 100,
              responseTime: Math.round(metrics.responseTime * 100) / 100,
              dataAccuracy: Math.round(metrics.dataAccuracy * 100) / 100,
              stakeAge: Math.round(metrics.stakeAge * 100) / 100,
              raw: metrics.raw
            }
          }
        }
        if (this._peerHealth) {
          entry.health = this._peerHealth.getStatus(pubkeyHex)
        }
        peers.push(entry)
      }
    }

    const status = {
      bridge: {
        name: this._config.name || null,
        version: PKG_VERSION,
        pubkeyHex: this._config.pubkeyHex || null,
        meshId: this._config.meshId || null,
        endpoint: this._config.endpoint || null,
        uptimeSeconds: Math.floor((Date.now() - this._startedAt) / 1000)
      },
      peers: {
        connected: this._peerManager ? this._peerManager.connectedCount() : 0,
        list: peers
      },
      headers: {
        bestHeight: this._headerRelay ? this._headerRelay.bestHeight : -1,
        bestHash: this._headerRelay ? this._headerRelay.bestHash : null,
        count: this._headerRelay ? this._headerRelay.headers.size : 0
      },
      txs: {
        mempool: this._txRelay ? this._txRelay.mempool.size : 0,
        known: this._txRelay ? this._txRelay.knownTxids.size : 0,
        seen: this._txRelay ? this._txRelay.seen.size : 0
      },
      bsvNode: {
        connected: this._bsvNodeClient ? this._bsvNodeClient.connectedCount > 0 : false,
        peers: this._bsvNodeClient ? this._bsvNodeClient.connectedCount : 0,
        height: this._bsvNodeClient ? this._bsvNodeClient.bestHeight : null,
        peerList: this._bsvNodeClient ? this._bsvNodeClient.peerList : []
      },
      teranode: this._teranodeClient ? this._teranodeClient.getStatus() : { enabled: false },
      system: {
        totalMemMB: Math.round(os.totalmem() / 1048576),
        freeMemMB: Math.round(os.freemem() / 1048576),
        usedMemMB: Math.round((os.totalmem() - os.freemem()) / 1048576),
        processRssMB: Math.round(process.memoryUsage.rss() / 1048576),
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100),
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        osUptime: Math.floor(os.uptime())
      }
    }

    // Operator-only fields
    if (authenticated) {
      status.operator = true
      status.bridge.domains = this._config.domains || []
      try {
        const { PrivateKey } = await import('@bsv/sdk')
        status.bridge.address = PrivateKey.fromWif(this._config.wif).toPublicKey().toAddress()
      } catch {
        status.bridge.address = this._config.address || null
      }
      status.wallet = { balanceSats: null, utxoCount: 0 }
      if (this._store) {
        try { status.wallet.balanceSats = await this._store.getBalance() } catch {}
        try { status.wallet.utxoCount = (await this._store.getUnspentUtxos()).length } catch {}
      }
    }

    return status
  }

  /**
   * Check if a request is authenticated via statusSecret.
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  _checkAuth (req) {
    const secret = this._config.statusSecret
    if (!secret) return false

    // Check ?auth= query param
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const authParam = url.searchParams.get('auth')
    if (authParam === secret) return true

    // Check Authorization: Bearer header
    const authHeader = req.headers.authorization
    if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7) === secret) return true

    return false
  }

  /**
   * Add a log entry to the ring buffer and notify SSE listeners.
   * @param {string} message
   */
  addLog (message) {
    const entry = { timestamp: Date.now(), message }
    this._logs.push(entry)
    if (this._logs.length > this._maxLogs) {
      this._logs.shift()
    }
    // Notify SSE listeners
    for (const listener of this._logListeners) {
      listener(entry)
    }
  }

  /**
   * Create a job for tracking async actions.
   * @returns {{ jobId: string, log: function }}
   */
  _createJob () {
    const jobId = `job_${++this._jobCounter}_${Date.now()}`
    const job = { status: 'running', events: [], done: false, listeners: new Set() }
    this._jobs.set(jobId, job)

    // Auto-cleanup after 5 minutes
    setTimeout(() => this._jobs.delete(jobId), 5 * 60 * 1000)

    const log = (type, message, data) => {
      const event = { type, message, data, timestamp: Date.now() }
      job.events.push(event)
      if (type === 'done' || type === 'error') {
        job.status = type === 'error' ? 'failed' : 'completed'
        job.done = true
      }
      // Notify SSE listeners
      for (const listener of job.listeners) {
        listener(event)
      }
    }

    return { jobId, log }
  }

  /**
   * Read the full JSON body from a request.
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<object>}
   */
  // Bound the request body so a caller can't OOM the process. Control routes default to
  // 256 KiB; broadcast routes pass STATUS_BROADCAST_MAX_BYTES (raw tx hex).
  _readBody (req, maxBytes = 262144) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let done = false
      const settle = (fn, arg) => { if (done) return; done = true; fn(arg) }
      req.on('data', chunk => {
        if (done) return
        size += chunk.length
        if (size > maxBytes) {
          const err = new Error('request body too large'); err.statusCode = 413
          try { req.destroy() } catch { /* already gone */ }
          settle(reject, err)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        // Buffer accumulation + single decode — avoids mis-decoding a multi-byte UTF-8 char
        // split across chunks (the string-concat path could).
        try { const body = Buffer.concat(chunks).toString('utf8'); settle(resolve, body ? JSON.parse(body) : {}) } catch (e) { settle(reject, e) }
      })
      req.on('error', (e) => settle(reject, e))
      // settle-once guard + reject on a premature close, so a dropped connection can't leave
      // this Promise (and its request handler) hanging forever.
      req.on('close', () => settle(reject, new Error('connection closed before body completed')))
    })
  }

  // Tiny per-IP sliding-window limiter for abuse-prone open routes (broadcast relay). Bounded:
  // prunes each IP's window on access, and caps the tracked-IP map.
  _rateLimit (req, bucket, max, windowMs) {
    if (!this._rateBuckets) this._rateBuckets = new Map()
    let m = this._rateBuckets.get(bucket)
    if (!m) { m = new Map(); this._rateBuckets.set(bucket, m) }
    const ip = req.socket && req.socket.remoteAddress
    if (!ip) return false // no identifiable source IP → fail closed, don't collapse into one shared bucket
    const now = Date.now()
    const floor = now - windowMs
    const hits = (m.get(ip) || []).filter(t => t > floor)
    if (hits.length >= max) { m.set(ip, hits); return false }
    hits.push(now)
    m.set(ip, hits)
    if (m.size > 5000) { for (const [k, v] of m) { if (!v.length || v[v.length - 1] <= floor) m.delete(k) } }
    return true
  }

  // Shared broadcast-body gate (jury refinement): ONE size-cap + rate-limit path for BOTH
  // /broadcast and /api/broadcast, so the two routes can't drift. Returns the parsed body, or
  // null after having already sent a 429 / 413 response (caller must return on null).
  async _readBroadcastBody (req, res) {
    if (!this._rateLimit(req, 'broadcast', BROADCAST_RATE_MAX, BROADCAST_RATE_WINDOW_MS)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'rate limit exceeded' }))
      return null
    }
    try {
      return await this._readBody(req, STATUS_BROADCAST_MAX_BYTES)
    } catch (e) {
      const code = e && e.statusCode === 413 ? 413 : 400
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: code === 413 ? 'request body too large' : 'invalid request body' }))
      return null
    }
  }

  /**
   * Check SSL certificate for a hostname.
   */
  _checkSSL (hostname) {
    return new Promise((resolve) => {
      const req = https.request({ hostname, port: 443, method: 'HEAD', rejectUnauthorized: false, timeout: 5000 }, (res) => {
        const cert = res.socket.getPeerCertificate()
        if (!cert || !cert.valid_to) { resolve(null); req.destroy(); return }
        resolve({
          valid: res.socket.authorized,
          issuer: cert.issuer?.O || cert.issuer?.CN || 'Unknown',
          expiresAt: new Date(cert.valid_to).toISOString(),
          daysRemaining: Math.floor((new Date(cert.valid_to) - Date.now()) / 86400000)
        })
        req.destroy()
      })
      req.on('error', () => resolve(null))
      req.setTimeout(5000, () => { req.destroy(); resolve(null) })
      req.end()
    })
  }

  /**
   * Health-check a single app.
   */
  async _checkApp (app) {
    const entry = this._appChecks.get(app.url)
    if (!entry) return
    const start = Date.now()
    let statusCode = 0
    let up = false
    let errorMsg = null
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(app.healthUrl || app.url, { method: app.healthUrl ? 'GET' : 'HEAD', signal: controller.signal, redirect: 'follow' })
      clearTimeout(timeout)
      statusCode = res.status
      up = statusCode >= 200 && statusCode < 400
    } catch (err) {
      errorMsg = err.message || 'Request failed'
    }
    const check = { timestamp: new Date().toISOString(), up, statusCode, responseTimeMs: Date.now() - start }
    entry.checks.push(check)
    if (entry.checks.length > 100) entry.checks.shift()
    if (!up) entry.lastError = { message: errorMsg || `HTTP ${statusCode}`, timestamp: check.timestamp }
  }

  /**
   * Run health checks on all configured apps.
   */
  async _checkAllApps () {
    if (!this._config.apps) return
    for (const app of this._config.apps) {
      await this._checkApp(app)
    }
  }

  /**
   * Start background app health monitoring (30s interval).
   */
  startAppMonitoring () {
    if (!this._config.apps || this._config.apps.length === 0) return
    this._checkAllApps()
    this._appCheckInterval = setInterval(() => this._checkAllApps(), 30000)
  }

  /**
   * Stop background app health monitoring.
   */
  stopAppMonitoring () {
    if (this._appCheckInterval) {
      clearInterval(this._appCheckInterval)
      this._appCheckInterval = null
    }
  }

  /**
   * Start background tx cleanup — deletes confirmed txs from PersistentStore.
   * Runs every 5 minutes. Checks ARC for confirmation status.
   */
  startTxCleanup () {
    if (!this._store) return
    const CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes
    const BATCH_SIZE = 50 // check 50 txs per cycle to avoid hammering ARC

    const cleanup = async () => {
      // g-Gamma-flap-fix: bail before starting if shutdown began
      if (this._isShuttingDown) return

      // Pass 1: Delete confirmed raw tx hex (existing behavior)
      try {
        let checked = 0
        let deleted = 0
        for await (const txid of this._store.listTxIds()) {
          if (this._isShuttingDown) break  // ← break the iterator on shutdown
          if (checked >= BATCH_SIZE) break
          checked++
          try {
            const arcRes = await fetch(`https://arc.gorillapool.io/v1/tx/${txid}`, {
              signal: AbortSignal.timeout(5000)
            })
            if (arcRes.ok) {
              const data = await arcRes.json().catch(() => null)
              // ARC returns txStatus: 'SEEN_ON_NETWORK' or 'MINED' etc.
              if (data && (data.txStatus === 'MINED' || data.blockHeight > 0)) {
                if (this._isShuttingDown) break  // last-second guard before db write
                await this._store.deleteTx(txid)
                deleted++
              }
            }
          } catch {} // skip this tx on error, try next cycle
        }
        if (deleted > 0) {
          console.log(`[tx-cleanup] Deleted ${deleted}/${checked} confirmed txs from PersistentStore`)
        }
      } catch (e) {
        // Suppress iterator/db errors that happen during shutdown — they're expected
        if (!this._isShuttingDown) console.error('[tx-cleanup] Error:', e.message)
      }

      if (this._isShuttingDown) return

      // Pass 2: Prune ghost UTXOs — unconfirmed UTXO txids that never got mined
      try {
        const utxoTxIds = await this._store.listUnspentUtxoTxIds()
        let ghostsDeleted = 0
        let utxosChecked = 0

        for (const txid of utxoTxIds) {
          if (this._isShuttingDown) break
          if (utxosChecked >= BATCH_SIZE) break
          utxosChecked++
          try {
            const arcRes = await fetch(`https://arc.gorillapool.io/v1/tx/${txid}`, {
              signal: AbortSignal.timeout(5000)
            })
            if (arcRes.ok) {
              const data = await arcRes.json().catch(() => null)
              if (data && (data.txStatus === 'MINED' || data.blockHeight > 0)) {
                continue // confirmed — keep this UTXO
              }
            }
            // Not mined — delete all UTXOs from this txid
            if (this._isShuttingDown) break
            const utxos = await this._store.getUnspentByTxId(txid)
            for (const u of utxos) {
              if (this._isShuttingDown) break
              await this._store.deleteUtxo(u.txid, u.vout)
              ghostsDeleted++
            }
          } catch {} // skip on error, try next cycle
        }
        if (ghostsDeleted > 0) {
          console.log(`[utxo-cleanup] Pruned ${ghostsDeleted} ghost UTXOs from ${utxosChecked} unconfirmed txids`)
        }
      } catch (e) {
        if (!this._isShuttingDown) console.error('[utxo-cleanup] Error:', e.message)
      }
    }

    // First run after 60s (let bridge stabilize), then every 5 minutes
    setTimeout(() => {
      this._activeCleanup = cleanup()
      this._txCleanupInterval = setInterval(() => {
        // Track the latest run so stop() can await it
        this._activeCleanup = cleanup()
      }, CLEANUP_INTERVAL)
    }, 60000)
  }

  /**
   * Stop background tx cleanup. Now async — waits for any in-flight cleanup
   * to break out of its loop before returning, so the caller can safely close
   * the underlying database without orphaning iterators.
   */
  async stopTxCleanup () {
    this._isShuttingDown = true
    if (this._txCleanupInterval) {
      clearInterval(this._txCleanupInterval)
      this._txCleanupInterval = null
    }
    if (this._activeCleanup) {
      try { await this._activeCleanup } catch {} // swallow any iterator-after-close
      this._activeCleanup = null
    }
  }

  /**
   * Start the HTTP server on localhost.
   * @returns {Promise<void>}
   */
  start () {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => {
        // CORS headers for federation dashboard
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        this._handleRequest(req, res).catch(err => {
          console.error('[status-server] Request failed:', req.url, err?.message || err)
          res.writeHead(500)
          res.end('Internal Server Error')
        })
      })

      // Personal mode (g-192): config.statusBindAddress can restrict the status
      // server to localhost (127.0.0.1) so a personal/home bridge doesn't expose
      // its dashboard to the network. Defaults to 0.0.0.0 (federation default).
      const bindAddr = this._config.statusBindAddress || '0.0.0.0'
      this._server.listen(this._port, bindAddr, () => {
        this.startTxCleanup()
        resolve()
      })
      this._server.on('error', reject)
    })
  }

  /**
   * Route incoming HTTP requests.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handleRequest (req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const authenticated = this._checkAuth(req)

    // Track requests from known app domains
    const origin = req.headers.origin || req.headers.referer || ''
    const host = (req.headers.host || '').split(':')[0]
    let trackDomain = null
    if (origin) { try { trackDomain = new URL(origin).hostname } catch {} }
    if (!trackDomain && host && this._appBridgeDomains.has(host)) trackDomain = host
    if (trackDomain && this._appBridgeDomains.has(trackDomain)) {
      let bridgeDomain = trackDomain
      if (this._config.apps) {
        for (const app of this._config.apps) {
          try { if (trackDomain === new URL(app.url).hostname) { bridgeDomain = app.bridgeDomain; break } } catch {}
        }
      }
      const data = this._requestTracker.get(bridgeDomain)
      if (data) {
        data.total++
        let ep = path
        if (path.startsWith('/tx/')) ep = '/tx/:txid'
        else if (path.startsWith('/inscription/')) ep = '/inscription/:content'
        else if (path.startsWith('/jobs/')) ep = '/jobs/:id'
        data.endpoints[ep] = (data.endpoints[ep] || 0) + 1
        data.lastSeen = new Date().toISOString()
      }
    }

    // GET /.well-known/x402 — pricing discovery (always free)
    if (req.method === 'GET' && path === '/.well-known/x402') {
      handleWellKnownX402(this._config, PKG_VERSION, res)
      return
    }

    // x402 payment gate — authenticated (operator) requests bypass
    if (this._paymentGate && !authenticated) {
      const result = await this._paymentGate(req.method, path, req)
      if (!result.ok) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result.body))
        return
      }
      if (result.receipt) req._x402Receipt = result.receipt
    }

    // GET /status — public or operator status
    if (req.method === 'GET' && path === '/status') {
      const status = await this.getStatus({ authenticated })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    // GET /mempool — public decoded mempool transactions
    if (req.method === 'GET' && path === '/mempool') {
      const txs = []
      if (this._txRelay) {
        for (const [txid, rawHex] of this._txRelay.mempool) {
          try {
            const parsed = parseTx(rawHex)
            txs.push({
              txid,
              size: rawHex.length / 2,
              inputs: parsed.inputs,
              outputs: parsed.outputs.map(o => ({
                vout: o.vout,
                satoshis: o.satoshis,
                isP2PKH: o.isP2PKH,
                hash160: o.hash160,
                type: o.type,
                data: o.data ? o.data.map(d => d.length > 128 ? d.slice(0, 128) + '...' : d) : o.data,
                protocol: o.protocol,
                parsed: o.parsed
              }))
            })
          } catch {
            txs.push({ txid, size: rawHex.length / 2, inputs: [], outputs: [], error: 'decode failed' })
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: txs.length, txs }))
      return
    }

    // GET /mempool/known/:txid — fast check if txid was seen on the BSV network
    const knownMatch = path.match(/^\/mempool\/known\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && knownMatch) {
      const txid = knownMatch[1]
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ known: true, source: 'mempool' }))
      } else if (this._txRelay && this._txRelay.knownTxids.has(txid)) {
        const firstSeen = this._txRelay.knownTxids.get(txid)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ known: true, source: 'inv', firstSeen }))
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ known: false }))
      }
      return
    }

    // GET /discover — public list of all known bridges in the mesh
    if (req.method === 'GET' && path === '/discover') {
      const bridges = []
      // Detect protocol from reverse proxy headers (Caddy, nginx) or default to http
      const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')
      // Add self
      bridges.push({
        name: this._config.name || null,
        pubkeyHex: this._config.pubkeyHex || null,
        endpoint: this._config.endpoint || null,
        meshId: this._config.meshId || null,
        statusUrl: proto + '://' + (req.headers.host || '127.0.0.1:' + this._port) + '/status'
      })
      // Add gossip directory (all known peers)
      if (this._gossipManager) {
        for (const peer of this._gossipManager.getDirectory()) {
          // statusPort is decoupled from gossip port — default 9333 unless peer advertised otherwise
          let statusUrl = null
          try {
            const u = new URL(peer.endpoint)
            const statusPort = peer.statusPort || 9333
            statusUrl = 'http://' + u.hostname + ':' + statusPort + '/status'
          } catch {}
          bridges.push({
            pubkeyHex: peer.pubkeyHex,
            endpoint: peer.endpoint,
            meshId: peer.meshId || null,
            statusUrl
          })
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ count: bridges.length, bridges }))
      return
    }

    // GET /mesh/proxy?url=... — proxy requests to other bridges (avoids mixed-content when dashboard is HTTPS)
    if (req.method === 'GET' && path === '/mesh/proxy') {
      // Unauthenticated public proxy — rate-limit per IP so a flood of concurrent requests
      // (each buffering up to the response cap) can't pressure memory.
      if (!this._rateLimit(req, 'proxy', 60, 60_000)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'rate limited' }))
        return
      }
      const targetUrl = url.searchParams.get('url')
      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Missing url parameter' }))
        return
      }
      let t
      try { t = new URL(targetUrl) } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Invalid URL' }))
        return
      }
      // scheme allowlist — block file://, gopher://, etc.
      if (t.protocol !== 'http:' && t.protocol !== 'https:') {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Scheme not allowed' }))
        return
      }
      // Only allow proxying to read-only mesh endpoints (path allowlist)
      const allowedPrefixes = ['/status', '/mempool', '/discover', '/tx/', '/address/', '/inscriptions', '/tokens', '/token/', '/apps', '/x402', '/proof/', '/api/crawler/', '/health']
      if (!allowedPrefixes.some(p => t.pathname === p || t.pathname.startsWith(p))) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Path not allowed through proxy' }))
        return
      }
      // SSRF: resolve the host, reject private/loopback/link-local targets, and PIN the
      // connection to the validated IP so a DNS rebind can't swap in an internal address
      // between check and connect.
      const host = t.hostname.replace(/^\[|\]$/g, '')
      let addrs
      try {
        addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await dns.lookup(host, { all: true })
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Host resolution failed' }))
        return
      }
      if (!addrs.length || addrs.some(a => isBlockedIp(a.address))) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Target host not allowed' }))
        return
      }
      // https can't be safely IP-pinned via fetch (the cert binds to the name, so we'd have to
      // re-resolve at connect — a rebind window). Mesh endpoints are http-by-IP, so reject an
      // https target that uses a hostname.
      if (!isIP(host) && t.protocol === 'https:') {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'https proxy target must be an IP' }))
        return
      }
      // Pin: for hostname targets over http (mesh endpoints are http), connect to the validated
      // IP with the original Host header. IP-literal targets are already pinned (no resolution).
      let fetchUrl = targetUrl
      // redirect:'manual' — fetch follows 3xx by default, so a validated target could 302 us to
      // an internal address, bypassing the IP checks. Don't follow; relay the redirect response
      // as-is (mesh endpoints return data directly, never redirect).
      const fetchOpts = { signal: AbortSignal.timeout(8000), redirect: 'manual' }
      if (!isIP(host) && t.protocol === 'http:') {
        const a0 = addrs[0]
        const ipHost = a0.family === 6 ? `[${a0.address}]` : a0.address
        const u2 = new URL(targetUrl); u2.hostname = ipHost
        fetchUrl = u2.toString()
        // t.host is already URL-validated (no CRLF/control chars); allowlist-sanitize as
        // belt-and-suspenders before forwarding it as the upstream Host header.
        if (/^[a-z0-9.\-:[\]]+$/i.test(t.host)) fetchOpts.headers = { Host: t.host }
      }
      try {
        const proxyRes = await fetch(fetchUrl, fetchOpts)
        // Bound the UPSTREAM response — a hostile/compromised target could otherwise stream an
        // unbounded body we'd buffer whole. Read with a 4 MiB cap, cancel if over.
        const MAX_PROXY_RESP = 4 * 1024 * 1024
        const parts = []
        let received = 0
        let over = false
        const reader = proxyRes.body && proxyRes.body.getReader ? proxyRes.body.getReader() : null
        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.length
            if (received > MAX_PROXY_RESP) { over = true; try { await reader.cancel() } catch {} ; break }
            parts.push(Buffer.from(value))
          }
        }
        if (over) {
          res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
          res.end(JSON.stringify({ error: 'upstream response too large' }))
          return
        }
        // nosniff so the reflected upstream content-type can't be sniffed into something executable.
        res.writeHead(proxyRes.status, { 'Content-Type': proxyRes.headers.get('content-type') || 'application/json', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' })
        res.end(Buffer.concat(parts))
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Proxy fetch failed', message: err.message }))
      }
      return
    }

    // GET / or /dashboard — built-in HTML dashboard
    if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': DASHBOARD_CSP })
      res.end(DASHBOARD_HTML)
      return
    }

    // GET /art/:filename — static art assets for Forest tab
    if (req.method === 'GET' && path.startsWith('/art/')) {
      const filename = path.slice(5)
      if (filename.includes('..') || filename.includes('/')) {
        res.writeHead(400)
        res.end('Bad request')
        return
      }
      const ext = filename.split('.').pop()
      const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
      try {
        const data = readFileSync(join(__dirname, '..', 'dashboard', 'art', filename))
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end('Not found')
      }
      return
    }

    // GET /vendor/:filename — locally-vendored dashboard libraries (three.js, OrbitControls).
    // Vendored so the credential-bearing dashboard origin never loads executable JS from a third-party CDN.
    if (req.method === 'GET' && path.startsWith('/vendor/')) {
      const filename = path.slice(8)
      if (filename.includes('..') || filename.includes('/') || !filename.endsWith('.js')) {
        res.writeHead(400)
        res.end('Bad request')
        return
      }
      try {
        const data = readFileSync(join(__dirname, '..', 'dashboard', 'vendor', filename))
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' })
        res.end(data)
      } catch {
        res.writeHead(404)
        res.end('Not found')
      }
      return
    }

    // POST /broadcast — relay a raw tx to peers (uses same waterfall as /api/broadcast)
    if (req.method === 'POST' && path === '/broadcast') {
      const body = await this._readBroadcastBody(req, res)
      if (body === null) return
      const { rawHex } = body
      if (!rawHex || typeof rawHex !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawHex required' }))
        return
      }
      const buf = Buffer.from(rawHex, 'hex')
      const hash = createHash('sha256').update(createHash('sha256').update(buf).digest()).digest()
      const txid = Buffer.from(hash).reverse().toString('hex')
      const relayPeers = this._txRelay ? this._txRelay.broadcastTx(txid, rawHex) : 0

      // Broadcast waterfall: P2P → ARC → WoC
      let confirmed = false
      let confirmSource = null

      if (this._bsvNodeClient && this._bsvNodeClient.connectedCount > 0) {
        try {
          await this._bsvNodeClient.broadcastTxAndWait(rawHex, 10000)
          confirmed = true
          confirmSource = 'p2p'
        } catch (e) {
          console.error('[broadcast] P2P failed:', txid.slice(0, 16), e.message)
        }
      }
      if (!confirmed) {
        try {
          const arcRes = await fetch('https://arc.gorillapool.io/v1/tx', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body: buf, signal: AbortSignal.timeout(10000)
          })
          if (await arcRelayed(arcRes)) { confirmed = true; confirmSource = 'arc' }
          else console.error('[broadcast] ARC not relayed (STORED/unknown):', txid.slice(0, 16))
        } catch (e) {
          console.error('[broadcast] ARC failed:', txid.slice(0, 16), e.message)
        }
      }
      if (!confirmed) {
        try {
          const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txhex: rawHex }), signal: AbortSignal.timeout(10000)
          })
          if (wocRes.ok) { confirmed = true; confirmSource = 'woc' }
          else {
            // A duplicate ("already in the mempool/blockchain") is a SUCCESS, not a failure —
            // else the client rebuilds a tx on the same inputs and creates a real double-spend.
            const wocErr = await wocRes.text().catch(() => '')
            if (TX_ALREADY_KNOWN_RE.test(wocErr)) { confirmed = true; confirmSource = 'woc-already-known' }
          }
        } catch (e) {
          console.error('[broadcast] WoC failed:', txid.slice(0, 16), e.message)
          if (TX_ALREADY_KNOWN_RE.test(e.message || '')) { confirmed = true; confirmSource = 'woc-already-known' }
        }
      }

      // Gossip our confirmation to the federation mesh
      if (confirmed && this._txRelay) {
        const bsvPeers = this._bsvNodeClient ? this._bsvNodeClient.connectedCount : 0
        this._txRelay.confirmTx(txid, confirmSource, bsvPeers)
      }

      if (confirmed) {
        const fed = this._txRelay ? this._txRelay.getConfirmations(txid) : { bridges: 0, totalBsvPeers: 0, confirmations: [] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ txid, peers: relayPeers, confirmed: true, source: confirmSource, federation: fed }))
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Broadcast failed — no miner accepted the transaction', txid }))
      }
      return
    }

    // POST /data — submit a signed data envelope for relay
    if (req.method === 'POST' && path === '/data') {
      if (!this._dataRelay) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Data relay not available' }))
        return
      }
      let body
      try {
        body = await this._readBody(req)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid_json' }))
        return
      }
      handlePostData(this._dataRelay, body, res)
      return
    }

    // GET /data/topics — list topics with summary objects
    if (req.method === 'GET' && path === '/data/topics') {
      if (!this._dataRelay) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Data relay not available' }))
        return
      }
      handleGetTopics(this._dataRelay, res)
      return
    }

    // GET /data/:topic — query cached envelopes with since/limit/hasMore
    if (req.method === 'GET' && path.startsWith('/data/')) {
      if (!this._dataRelay) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Data relay not available' }))
        return
      }
      const topic = decodeURIComponent(path.slice(6))
      if (!topic) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Topic required' }))
        return
      }
      handleGetData(this._dataRelay, topic, url.searchParams, res)
      return
    }

    // GET /tx/:txid — fetch and parse transaction with full protocol support
    if (req.method === 'GET' && path.startsWith('/tx/')) {
      const txid = path.slice(4)
      if (!txid || txid.length !== 64) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid txid' }))
        return
      }

      let rawHex = null
      let source = null

      // Check mempool first
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        rawHex = this._txRelay.mempool.get(txid)
        source = 'mempool'
      }

      // Try P2P
      if (!rawHex && this._bsvNodeClient) {
        try {
          const result = await this._bsvNodeClient.getTx(txid, 5000)
          rawHex = result.rawHex
          source = 'p2p'
        } catch {}
      }

      // Fall back to WoC
      if (!rawHex) {
        try {
          const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
          if (!resp.ok) throw new Error(`WoC ${resp.status}`)
          rawHex = await resp.text()
          source = 'woc'
        } catch (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `tx not found: ${err.message}` }))
          return
        }
      }

      // Parse with full protocol support
      try {
        const parsed = parseTx(rawHex)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          txid: parsed.txid,
          source,
          size: rawHex.length / 2,
          inputs: parsed.inputs,
          outputs: parsed.outputs
        }))
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ txid, source, size: rawHex.length / 2, error: 'parse failed: ' + err.message }))
      }
      return
    }

    // POST /register — operator: start async registration
    if (req.method === 'POST' && path === '/register') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runRegister } = await import('./actions.js')
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      // Run async — don't await
      runRegister({ config: this._config, store: this._store, log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // POST /deregister — operator: start async deregistration
    if (req.method === 'POST' && path === '/deregister') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runDeregister } = await import('./actions.js')
      const body = await this._readBody(req)
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      runDeregister({ config: this._config, store: this._store, reason: body.reason || 'shutdown', log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // POST /fund — operator: store a funding tx (synchronous)
    if (req.method === 'POST' && path === '/fund') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runFund } = await import('./actions.js')
      const body = await this._readBody(req)
      if (!body.rawHex) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawHex required' }))
        return
      }
      try {
        const result = await runFund({ config: this._config, store: this._store, rawHex: body.rawHex, log: () => {} })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // POST /connect — operator: connect to a peer endpoint
    if (req.method === 'POST' && path === '/connect') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const body = await this._readBody(req)
      if (!body.endpoint) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'endpoint required (e.g. ws://host:port)' }))
        return
      }
      if (!this._peerManager || !this._performOutboundHandshake) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bridge not running — peer manager unavailable' }))
        return
      }
      try {
        const conn = this._peerManager.connectToPeer({ endpoint: body.endpoint })
        if (conn) {
          conn.on('open', () => this._performOutboundHandshake(conn))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ endpoint: body.endpoint, status: 'connecting' }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ endpoint: body.endpoint, status: 'already_connected_or_failed' }))
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // POST /send — operator: send BSV from bridge wallet
    if (req.method === 'POST' && path === '/send') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runSend } = await import('./actions.js')
      const body = await this._readBody(req)
      if (!body.toAddress || !body.amount) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'toAddress and amount required' }))
        return
      }
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      runSend({ config: this._config, store: this._store, toAddress: body.toAddress, amount: Number(body.amount), log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // GET /jobs/:id — SSE stream for job progress
    if (req.method === 'GET' && path.startsWith('/jobs/')) {
      const jobId = path.slice(6)
      const job = this._jobs.get(jobId)
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Job not found' }))
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // Replay past events
      for (const event of job.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      if (job.done) {
        res.write(`data: ${JSON.stringify({ type: 'end', status: job.status })}\n\n`)
        res.end()
        return
      }
      // Stream new events
      const listener = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
        if (event.type === 'done' || event.type === 'error') {
          res.write(`data: ${JSON.stringify({ type: 'end', status: event.type === 'error' ? 'failed' : 'completed' })}\n\n`)
          res.end()
          job.listeners.delete(listener)
        }
      }
      job.listeners.add(listener)
      req.on('close', () => job.listeners.delete(listener))
      return
    }

    // GET /logs — SSE stream of live bridge logs
    if (req.method === 'GET' && path === '/logs') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      })
      // Replay buffer
      for (const entry of this._logs) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
      // Stream new
      const listener = (entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`)
      }
      this._logListeners.add(listener)
      req.on('close', () => this._logListeners.delete(listener))
      return
    }

    // GET /inscriptions — query indexed inscriptions
    if (req.method === 'GET' && path === '/inscriptions') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const mime = url.searchParams.get('mime')
      const address = url.searchParams.get('address')
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200)
      try {
        const inscriptions = await this._store.getInscriptions({ mime, address, limit })
        const total = await this._store.getInscriptionCount()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ total, count: inscriptions.length, inscriptions, filters: { mime: mime || null, address: address || null } }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /address/:addr/history — local sessions first, WoC fallback
    const addrMatch = path.match(/^\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/history$/)
    if (req.method === 'GET' && addrMatch) {
      const addr = addrMatch[1]
      const cached = this._addressCache.get(addr)
      if (cached && Date.now() - cached.time < 60000) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ address: addr, history: cached.data, cached: true }))
        return
      }
      try {
        // Local sessions from LevelDB (source of truth)
        const localSessions = await this._store.getSessions(addr, 2000)
        const seen = new Set(localSessions.map(s => s.txId))
        const history = localSessions.map(s => ({ tx_hash: s.txId, height: -1 }))

        // WoC fallback for older txs + block heights
        try {
          const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/address/' + addr + '/confirmed/history', { signal: AbortSignal.timeout(10000) })
          if (resp.ok) {
            const data = await resp.json()
            const wocHistory = Array.isArray(data) ? data : (data.result || [])
            for (const entry of wocHistory) {
              if (seen.has(entry.tx_hash)) {
                const match = history.find(h => h.tx_hash === entry.tx_hash)
                if (match && entry.height > 0) match.height = entry.height
              } else {
                history.push(entry)
                seen.add(entry.tx_hash)
              }
            }
          }
        } catch {} // WoC failure doesn't block response

        this._addressCache.set(addr, { data: history, time: Date.now() })
        if (this._addressCache.size > 100) {
          const oldest = this._addressCache.keys().next().value
          this._addressCache.delete(oldest)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ address: addr, history, cached: false }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to fetch address history: ' + err.message }))
      }
      return
    }

    // GET /price — cached BSV/USD exchange rate
    if (req.method === 'GET' && path === '/price') {
      const now = Date.now()
      if (!this._priceCache || now - this._priceCache.timestamp > 60000) {
        try {
          const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/exchangerate')
          if (resp.ok) {
            const data = await resp.json()
            this._priceCache = { data, timestamp: now }
          }
        } catch {}
      }
      if (this._priceCache) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          usd: this._priceCache.data.rate || this._priceCache.data.USD,
          currency: 'USD',
          source: 'whatsonchain',
          cached: this._priceCache.timestamp,
          ttl: 60000
        }))
        return
      }
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Price unavailable' }))
      return
    }

    // GET /tokens — list all deployed tokens
    if (req.method === 'GET' && path === '/tokens') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const tokens = await this._store.listTokens()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tokens }))
      return
    }

    // GET /token/:tick — token deploy info
    const tokenMatch = path.match(/^\/token\/([^/]+)$/)
    if (req.method === 'GET' && tokenMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const token = await this._store.getToken(decodeURIComponent(tokenMatch[1]))
      if (!token) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Token not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(token))
      return
    }

    // GET /token/:tick/balance/:scriptHash — token balance for owner
    const balMatch = path.match(/^\/token\/([^/]+)\/balance\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && balMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const tick = decodeURIComponent(balMatch[1])
      const ownerScriptHash = balMatch[2]
      const balance = await this._store.getTokenBalance(tick, ownerScriptHash)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ tick, ownerScriptHash, balance }))
      return
    }

    // GET /tx/:txid/status — tx lifecycle state
    const statusMatch = path.match(/^\/tx\/([0-9a-f]{64})\/status$/)
    if (req.method === 'GET' && statusMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const txid = statusMatch[1]
      const status = await this._store.getTxStatus(txid)
      const block = await this._store.getTxBlock(txid)
      if (!status) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Transaction not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, ...status, block: block || undefined }))
      return
    }

    // GET /proof/:txid — merkle proof for confirmed tx
    const proofMatch = path.match(/^\/proof\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && proofMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      const txid = proofMatch[1]
      const block = await this._store.getTxBlock(txid)
      if (!block || !block.proof) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Proof not available' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, blockHash: block.blockHash, height: block.height, proof: block.proof }))
      return
    }

    // GET /inscription/:txid/:vout/content — serve raw inscription content
    const inscMatch = path.match(/^\/inscription\/([0-9a-f]{64})\/(\d+)\/content$/)
    if (req.method === 'GET' && inscMatch) {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Store not available')
        return
      }
      try {
        const record = await this._store.getInscription(inscMatch[1], parseInt(inscMatch[2], 10))
        if (!record) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Not found')
          return
        }
        // Resolve content: inline hex first, then CAS fallback
        let buf = record.content ? Buffer.from(record.content, 'hex') : null
        if (!buf && record.contentHash) {
          buf = await this._store.getContentBytes(record.contentHash)
        }
        if (!buf) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('Content not available')
          return
        }
        res.writeHead(200, {
          'Content-Type': record.contentType || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=31536000, immutable'
        })
        res.end(buf)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end(err.message)
      }
      return
    }

    // POST /scan-address — scan an address for inscriptions via WhatsOnChain
    if (req.method === 'POST' && path === '/scan-address') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', async () => {
        try {
          const { address } = JSON.parse(body)
          if (!address || typeof address !== 'string' || address.length < 25 || address.length > 35) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Invalid address' }))
            return
          }

          // Stream progress via SSE
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          })

          const result = await scanAddress(address, this._store, (progress) => {
            res.write('data: ' + JSON.stringify(progress) + '\n\n')
          })

          res.write('data: ' + JSON.stringify({ phase: 'complete', result }) + '\n\n')
          res.end()
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          } else {
            res.write('data: ' + JSON.stringify({ phase: 'error', error: err.message }) + '\n\n')
            res.end()
          }
        }
      })
      return
    }

    // POST /rebuild-inscription-index — deduplicate and rebuild secondary indexes
    if (req.method === 'POST' && path === '/rebuild-inscription-index') {
      if (!this._store) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Store not available' }))
        return
      }
      try {
        const count = await this._store.rebuildInscriptionIndex()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ rebuilt: count }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /apps — app health, SSL, and usage data
    if (req.method === 'GET' && path === '/apps') {
      const apps = []
      if (this._config.apps) {
        for (const app of this._config.apps) {
          const entry = this._appChecks.get(app.url) || { checks: [], lastError: null }
          const checks = entry.checks
          const checksUp = checks.filter(c => c.up).length
          const latest = checks.length > 0 ? checks[checks.length - 1] : null

          let ssl = null
          try {
            const hostname = new URL(app.url).hostname
            const cached = this._appSSLCache.get(hostname)
            if (cached && cached.data && Date.now() - cached.checkedAt < 3600000) {
              ssl = cached.data
            } else {
              ssl = await this._checkSSL(hostname)
              this._appSSLCache.set(hostname, { data: ssl, checkedAt: Date.now() })
            }
          } catch {}

          const usage = this._requestTracker.get(app.bridgeDomain) || { total: 0, endpoints: {}, lastSeen: null }

          apps.push({
            name: app.name,
            url: app.url,
            bridgeDomain: app.bridgeDomain,
            health: {
              status: latest ? (latest.up ? 'online' : 'offline') : 'unknown',
              statusCode: latest ? latest.statusCode : 0,
              responseTimeMs: latest ? latest.responseTimeMs : 0,
              lastCheck: latest ? latest.timestamp : null,
              lastError: entry.lastError,
              uptimePercent: checks.length > 0 ? Math.round((checksUp / checks.length) * 1000) / 10 : 0,
              checksTotal: checks.length,
              checksUp
            },
            ssl,
            usage: {
              totalRequests: usage.total,
              endpoints: { ...usage.endpoints },
              lastSeen: usage.lastSeen
            }
          })
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ apps }))
      return
    }

    // GET /x402 — payment gate stats (operator-only details when authenticated)
    if (req.method === 'GET' && path === '/x402') {
      const x402Config = this._config.x402 || {}
      const enabled = !!(x402Config.enabled && x402Config.payTo)
      const result = {
        enabled,
        payTo: x402Config.payTo || '',
        endpoints: []
      }

      // Build pricing table
      if (x402Config.endpoints) {
        for (const [key, satoshis] of Object.entries(x402Config.endpoints)) {
          const colonIdx = key.indexOf(':')
          if (colonIdx === -1) continue
          result.endpoints.push({
            method: key.slice(0, colonIdx),
            path: key.slice(colonIdx + 1),
            satoshis
          })
        }
      }

      // Read receipts from LevelDB if store is available
      if (this._store && this._store._paymentReceipts) {
        let totalReceipts = 0
        let totalSatsEarned = 0n
        let pendingClaims = 0
        const recentReceipts = []
        const now = Date.now()
        const oneDayAgo = now - 86400000
        const oneWeekAgo = now - 604800000
        let todaySats = 0n
        let weekSats = 0n

        try {
          for await (const [key, val] of this._store._paymentReceipts.iterator({ gte: 'u!', lt: 'u~' })) {
            if (val.status === 'receipt') {
              totalReceipts++
              const paid = BigInt(val.satoshisPaid || val.satoshisRequired || '0')
              totalSatsEarned += paid
              if (val.createdAt && val.createdAt > oneDayAgo) todaySats += paid
              if (val.createdAt && val.createdAt > oneWeekAgo) weekSats += paid
              if (recentReceipts.length < 20) {
                recentReceipts.push({
                  txid: val.txid || key.slice(2),
                  satoshisPaid: (val.satoshisPaid || val.satoshisRequired || '0'),
                  endpoint: val.endpointKey || val.endpoint || '',
                  createdAt: val.createdAt || null
                })
              }
            } else if (val.status === 'claimed') {
              pendingClaims++
            }
          }
        } catch {}

        result.revenue = {
          totalReceipts,
          totalSatsEarned: totalSatsEarned.toString(),
          todaySats: todaySats.toString(),
          weekSats: weekSats.toString(),
          pendingClaims
        }
        if (authenticated) {
          result.recentReceipts = recentReceipts.reverse()
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(result))
      return
    }

    // PATCH /x402 — update x402 settings (operator-only)
    if (req.method === 'PATCH' && path === '/x402') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      try {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString())

        // Update in-memory config
        if (!this._config.x402) this._config.x402 = {}
        if (body.enabled !== undefined) this._config.x402.enabled = !!body.enabled
        if (body.payTo !== undefined) this._config.x402.payTo = String(body.payTo)
        if (body.endpoints !== undefined && typeof body.endpoints === 'object') {
          // Validate all prices are non-negative safe integers
          for (const [key, price] of Object.entries(body.endpoints)) {
            if (!Number.isSafeInteger(price) || price < 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: `Invalid price for ${key}: must be a non-negative integer` }))
              return
            }
          }
          this._config.x402.endpoints = body.endpoints
        }

        // Write config to disk
        const configDir = this._config.dataDir ? dirname(this._config.dataDir) : join(os.homedir(), '.relay-bridge')
        const configPath = join(configDir, 'config.json')
        writeFileSync(configPath, JSON.stringify(this._config, null, 2))

        // Recreate payment gate with new settings
        if (this._config.x402.enabled && this._config.x402.payTo && this._store) {
          try {
            const fetchTx = async (txid, opts) => {
              const resp = await fetch(
                `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`,
                { signal: opts?.signal || AbortSignal.timeout(5000) }
              )
              if (!resp.ok) {
                const err = new Error(`WoC ${resp.status}`)
                err.httpStatus = resp.status
                throw err
              }
              return await resp.json()
            }
            this._paymentGate = createPaymentGate(this._config, this._store, fetchTx)
          } catch (err) {
            console.error('[x402] Failed to recreate payment gate:', err.message)
            this._paymentGate = null
          }
        } else {
          this._paymentGate = null
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, x402: this._config.x402 }))
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // GET /health — MCP/CLI compatibility
    if (req.method === 'GET' && path === '/health') {
      const status = await this.getStatus()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        headerHeight: status.headers.bestHeight,
        connectedPeers: status.bsvNode.peers,
        synced: status.headers.bestHeight > 0
      }))
      return
    }

    // GET /api/bsv-peers — connected BSV P2P peer IPs (for DNS seed crawler)
    if (req.method === 'GET' && path === '/api/bsv-peers') {
      const list = this._bsvNodeClient ? this._bsvNodeClient.peerList : []
      const connected = list.filter(p => p.connected && p.handshake)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(connected.map(p => ({
        host: p.host,
        height: p.bestHeight,
        userAgent: p.userAgent
      }))))
      return
    }

    // GET /api/crawler/health — proxy to local crawler (Alpha only, returns available:false if no crawler)
    if (req.method === 'GET' && path === '/api/crawler/health') {
      try {
        const r = await fetch('http://localhost:8053/health', { signal: AbortSignal.timeout(2000) })
        const data = await r.json()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, ...data }))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: false }))
      }
      return
    }

    // GET /api/crawler/peers — proxy to local crawler /peers
    if (req.method === 'GET' && path === '/api/crawler/peers') {
      try {
        const r = await fetch('http://localhost:8053/peers', { signal: AbortSignal.timeout(3000) })
        const data = await r.json()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: true, peers: data }))
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ available: false, peers: [] }))
      }
      return
    }

    // GET /api/address/:addr/mempool — unconfirmed txs from bridge mempool
    const mempoolMatch = path.match(/^\/api\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/mempool$/)
    if (req.method === 'GET' && mempoolMatch) {
      const addr = mempoolMatch[1]
      const results = []
      if (this._txRelay) {
        let hash160
        try { hash160 = addressToHash160(addr) } catch {}
        if (hash160) {
          const watchSet = new Set([hash160])
          for (const [txid, rawHex] of this._txRelay.mempool) {
            try {
              const parsed = parseTx(rawHex)
              for (const out of parsed.outputs) {
                if (out.hash160 && watchSet.has(out.hash160)) {
                  results.push({ txid, vout: out.vout, satoshis: out.satoshis, height: -1 })
                }
              }
            } catch {}
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(results))
      return
    }

    // GET /api/address/:addr/unspent — local store first, GorillaPool fallback
    const unspentMatch = path.match(/^\/api\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/unspent$/)
    if (req.method === 'GET' && unspentMatch) {
      const addr = unspentMatch[1]

      // Auto-watch this address so future P2P txs are tracked locally
      if (this._addressWatcher) {
        try { this._addressWatcher.watchAddress(addr) } catch {}
      }

      // Query both local store and GorillaPool in parallel, merge, dedupe
      const localPromise = this._store
        ? this._store.getUnspentByAddress(addr).catch(() => [])
        : Promise.resolve([])
      const gpPromise = fetch(
        `https://ordinals.gorillapool.io/api/txos/address/${addr}/unspent`,
        { signal: AbortSignal.timeout(10000) }
      ).then(r => r.ok ? r.json() : []).catch(() => [])

      const [localUtxos, gpData] = await Promise.all([localPromise, gpPromise])

      // Debug logs removed
      // Merge GP + local, filtering out UTXOs spent by recent broadcasts.
      // GP is authoritative for confirmed UTXOs but doesn't know about
      // unconfirmed spends. Local store tracks both new outputs and spends.
      const seen = new Set()
      const merged = []

      // Start with GP data — GP is authoritative for confirmed UTXOs
      for (const u of gpData) {
        const key = `${u.txid}:${u.vout}`
        if (seen.has(key)) continue
        let spent = false
        if (this._store) {
          try { spent = await this._store.isInputSpent(u.txid, u.vout) } catch {}
        }
        // GP is authoritative for confirmed UTXOs. If GP says unspent AND
        // confirmed (height > 0), our local spentInputs entry is stale.
        if (spent && u.height > 0 && this._store) {
          console.log(`[ghost-fix] Clearing stale spent entry: ${key} (GP height ${u.height})`)
          try { await this._store.clearSpentInput(u.txid, u.vout) } catch {}
          spent = false
        }
        if (!spent) { seen.add(key); merged.push({ tx_hash: u.txid, tx_pos: u.vout, value: Number(u.satoshis), height: u.height || -1 }) }
      }

      // Add local unspent UTXOs that GP doesn't have — but ONLY if recent.
      // GP is truth for the confirmed UTXO set. If GP doesn't have it, it's
      // either a very recent broadcast (not yet indexed) or a ghost UTXO
      // (spent on-chain but local store never saw the spending tx).
      // Only include local-only UTXOs created in the last 120 seconds.
      const recentCutoff = Date.now() - 120000
      for (const u of localUtxos) {
        const key = `${u.txid}:${u.vout}`
        if (seen.has(key)) continue
        // Only include if recently added (unconfirmed broadcast we just did)
        if (u.addedAt && u.addedAt > recentCutoff) {
          seen.add(key)
          merged.push({ tx_hash: u.txid, tx_pos: u.vout, value: Number(u.satoshis), height: -1 })
        } else {
          // Ghost UTXO — GP doesn't have it, it's old. Mark as spent.
          if (this._store) {
            try { await this._store.spendUtxo(u.txid, u.vout) } catch {}
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(merged))
      return
    }

    // GET /api/tx/:txid/propagation — federation-wide confirmation status
    const propMatch = path.match(/^\/api\/tx\/([0-9a-f]{64})\/propagation$/)
    if (req.method === 'GET' && propMatch) {
      const txid = propMatch[1]
      const fed = this._txRelay ? this._txRelay.getConfirmations(txid) : { bridges: 0, totalBsvPeers: 0, confirmations: [] }
      const known = this._txRelay ? this._txRelay.hasSeen(txid) : false
      const inMempool = this._txRelay ? this._txRelay.mempool.has(txid) : false
      res.writeHead(200, { ...this._corsHeaders, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, known, inMempool, federation: fed }))
      return
    }

    // GET /api/tx/:txid/hex — raw transaction hex
    const hexMatch = path.match(/^\/api\/tx\/([0-9a-f]{64})\/hex$/)
    if (req.method === 'GET' && hexMatch) {
      const txid = hexMatch[1]
      let rawHex = null
      // Mempool first
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        rawHex = this._txRelay.mempool.get(txid)
      }
      // Local PersistentStore (broadcast-tracked txs)
      if (!rawHex && this._store) {
        try {
          const stored = await this._store.getTx(txid)
          if (stored) rawHex = stored
        } catch {}
      }
      // P2P second
      if (!rawHex && this._bsvNodeClient) {
        try {
          const result = await this._bsvNodeClient.getTx(txid, 5000)
          rawHex = result.rawHex
        } catch {}
      }
      // WoC fallback
      if (!rawHex) {
        try {
          const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
          if (resp.ok) rawHex = await resp.text()
        } catch {}
      }
      if (rawHex) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end(rawHex)
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tx not found' }))
      }
      return
    }

    // POST /api/broadcast — MCP/CLI compatibility (accepts { rawTx } key)
    if (req.method === 'POST' && path === '/api/broadcast') {
      const body = await this._readBroadcastBody(req, res)
      if (body === null) return
      const rawHex = body.rawTx || body.rawHex
      if (!rawHex || typeof rawHex !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawTx or rawHex required' }))
        return
      }
      if (!/^[0-9a-fA-F]+$/.test(rawHex) || rawHex.length % 2 !== 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid hex string' }))
        return
      }
      const buf = Buffer.from(rawHex, 'hex')
      const hash = createHash('sha256').update(createHash('sha256').update(buf).digest()).digest()
      const txid = Buffer.from(hash).reverse().toString('hex')

      // Store raw tx + mark spent inputs (local cache for reads + UTXO tracking)
      if (this._store) {
        try {
          await this._store.putTx(txid, rawHex)
          const parsed = parseTx(rawHex)
          for (const input of parsed.inputs) {
            await this._store.markInputSpent(input.prevTxid, input.prevVout, txid)
          }
        } catch {}
      }

      // Relay to other bridges (background, not a miner path)
      const relayPeers = this._txRelay ? this._txRelay.broadcastTx(txid, rawHex) : 0

      // Broadcast waterfall: P2P → ARC → WoC. Wait for confirmation at each step.
      let confirmed = false
      let confirmSource = null

      // 1. P2P broadcast — wait for a BSV node to request the tx via getdata
      if (!confirmed && this._bsvNodeClient && this._bsvNodeClient.connectedCount > 0) {
        try {
          await this._bsvNodeClient.broadcastTxAndWait(rawHex, 10000)
          confirmed = true
          confirmSource = 'p2p'
        } catch (e) {
          console.error('[broadcast] P2P failed:', txid.slice(0, 16), e.message)
        }
      }

      // 2. ARC fallback — submit to GorillaPool miner, wait for response
      if (!confirmed) {
        try {
          const arcRes = await fetch('https://arc.gorillapool.io/v1/tx', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: buf,
            signal: AbortSignal.timeout(10000)
          })
          if (await arcRelayed(arcRes)) {
            confirmed = true
            confirmSource = 'arc'
          } else {
            console.error('[broadcast] ARC not relayed (STORED/unknown):', txid.slice(0, 16), arcRes.status)
          }
        } catch (e) {
          console.error('[broadcast] ARC failed:', txid.slice(0, 16), e.message)
        }
      }

      // 3. WoC fallback — last resort
      if (!confirmed) {
        try {
          const wocRes = await fetch('https://api.whatsonchain.com/v1/bsv/main/tx/raw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txhex: rawHex }),
            signal: AbortSignal.timeout(10000)
          })
          if (wocRes.ok) {
            confirmed = true
            confirmSource = 'woc'
          } else {
            const wocErr = await wocRes.text().catch(() => '')
            // A duplicate ("already in the mempool/blockchain") is a SUCCESS, not a failure.
            if (TX_ALREADY_KNOWN_RE.test(wocErr)) { confirmed = true; confirmSource = 'woc-already-known' }
            else console.error('[broadcast] WoC rejected:', txid.slice(0, 16), wocRes.status, wocErr.slice(0, 200))
          }
        } catch (e) {
          console.error('[broadcast] WoC failed:', txid.slice(0, 16), e.message)
          if (TX_ALREADY_KNOWN_RE.test(e.message || '')) { confirmed = true; confirmSource = 'woc-already-known' }
        }
      }

      // Gossip our confirmation to the federation mesh
      if (confirmed && this._txRelay) {
        const bsvPeers = this._bsvNodeClient ? this._bsvNodeClient.connectedCount : 0
        this._txRelay.confirmTx(txid, confirmSource, bsvPeers)
      }

      if (confirmed) {
        const fed = this._txRelay ? this._txRelay.getConfirmations(txid) : { bridges: 0, totalBsvPeers: 0, confirmations: [] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ txid, peers: relayPeers, confirmed: true, source: confirmSource, federation: fed }))
      } else {
        console.error('[broadcast] ALL PATHS FAILED for', txid.slice(0, 16))
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Broadcast failed — no miner accepted the transaction', txid }))
      }
      return
    }

    // GET /api/address/:addr/history — local sessions first, WoC fallback (web app compat)
    const apiHistMatch = path.match(/^\/api\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/history$/)
    if (req.method === 'GET' && apiHistMatch) {
      const addr = apiHistMatch[1]
      const cached = this._addressCache.get(addr)
      if (cached && Date.now() - cached.time < 60000) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(cached.data))
        return
      }
      try {
        // Local sessions from LevelDB (source of truth)
        const localSessions = await this._store.getSessions(addr, 2000)
        const seen = new Set(localSessions.map(s => s.txId))
        const history = localSessions.map(s => ({ tx_hash: s.txId, height: -1 }))

        // WoC fallback for older txs + block heights
        try {
          const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/address/' + addr + '/confirmed/history', { signal: AbortSignal.timeout(10000) })
          if (resp.ok) {
            const data = await resp.json()
            const wocHistory = Array.isArray(data) ? data : (data.result || [])
            for (const entry of wocHistory) {
              if (seen.has(entry.tx_hash)) {
                const match = history.find(h => h.tx_hash === entry.tx_hash)
                if (match && entry.height > 0) match.height = entry.height
              } else {
                history.push(entry)
                seen.add(entry.tx_hash)
              }
            }
          }
        } catch {} // WoC failure doesn't block response

        this._addressCache.set(addr, { data: history, time: Date.now() })
        if (this._addressCache.size > 100) {
          const oldest = this._addressCache.keys().next().value
          this._addressCache.delete(oldest)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(history))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Failed to fetch address history: ' + err.message }))
      }
      return
    }

    // GET /api/address/:addr/balance — local store first, GorillaPool fallback
    const apiBalMatch = path.match(/^\/api\/address\/([13][a-km-zA-HJ-NP-Z1-9]{24,33})\/balance$/)
    if (req.method === 'GET' && apiBalMatch) {
      const addr = apiBalMatch[1]

      // Auto-watch
      if (this._addressWatcher) {
        try { this._addressWatcher.watchAddress(addr) } catch {}
      }

      // Query both sources in parallel, merge, dedupe, sum
      const localBal = this._store
        ? this._store.getUnspentByAddress(addr).catch(() => [])
        : Promise.resolve([])
      const gpBal = fetch(
        `https://ordinals.gorillapool.io/api/txos/address/${addr}/unspent`,
        { signal: AbortSignal.timeout(10000) }
      ).then(r => r.ok ? r.json() : []).catch(() => [])

      const [localUtxos, gpData] = await Promise.all([localBal, gpBal])
      // GP is authoritative — it tracks the real UTXO set.
      // Local store only used as fallback when GP is down/empty.
      const seen = new Set()
      let confirmed = 0
      const source = gpData.length > 0 ? gpData : localUtxos
      for (const u of source) {
        const key = `${u.txid}:${u.vout}`
        if (!seen.has(key)) { seen.add(key); confirmed += u.satoshis || 0 }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ confirmed, unconfirmed: 0 }))
      return
    }

    // GET /api/tx/:txid — parsed tx JSON from bridge data (mempool/store/P2P)
    const apiTxMatch = path.match(/^\/api\/tx\/([0-9a-f]{64})$/)
    if (req.method === 'GET' && apiTxMatch) {
      const txid = apiTxMatch[1]
      let rawHex = null
      // Mempool first
      if (this._txRelay && this._txRelay.mempool.has(txid)) {
        rawHex = this._txRelay.mempool.get(txid)
      }
      // Local PersistentStore
      if (!rawHex && this._store) {
        try {
          const stored = await this._store.getTx(txid)
          if (stored) rawHex = stored
        } catch {}
      }
      // P2P
      if (!rawHex && this._bsvNodeClient) {
        try {
          const result = await this._bsvNodeClient.getTx(txid, 5000)
          rawHex = result.rawHex
        } catch {}
      }
      if (!rawHex) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tx not found' }))
        return
      }
      try {
        const buf = Buffer.from(rawHex, 'hex')
        let pos = 4
        const readVarint = () => {
          const first = buf[pos++]
          if (first < 0xfd) return first
          if (first === 0xfd) { const v = buf.readUInt16LE(pos); pos += 2; return v }
          if (first === 0xfe) { const v = buf.readUInt32LE(pos); pos += 4; return v }
          const v = Number(buf.readBigUInt64LE(pos)); pos += 8; return v
        }
        const inCount = readVarint()
        for (let i = 0; i < inCount; i++) {
          pos += 32 + 4
          const scriptLen = readVarint()
          pos += scriptLen + 4
        }
        const outCount = readVarint()
        const vout = []
        for (let i = 0; i < outCount; i++) {
          const satoshis = Number(buf.readBigUInt64LE(pos)); pos += 8
          const scriptLen = readVarint()
          const scriptHex = buf.subarray(pos, pos + scriptLen).toString('hex')
          pos += scriptLen
          vout.push({ value: satoshis / 1e8, n: i, scriptPubKey: { hex: scriptHex } })
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ txid, vout }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tx parse failed: ' + err.message }))
      }
      return
    }

    // GET /api/mesh/status — alias for /status (web app compat)
    if (req.method === 'GET' && path === '/api/mesh/status') {
      const status = await this.getStatus({ authenticated })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }

  /**
   * Stop the HTTP server.
   * @returns {Promise<void>}
   */
  async stop () {
    this.stopAppMonitoring()
    // g-Gamma-flap-fix: stop tx cleanup BEFORE closing HTTP — and wait for
    // any in-flight iteration to break out, so the caller's subsequent
    // store.close() doesn't orphan a LevelDB iterator and spam errors.
    await this.stopTxCleanup()
    return new Promise((resolve) => {
      if (this._server) {
        this._server.close(() => resolve())
        this._server = null
      } else {
        resolve()
      }
    })
  }

  /**
   * Get the port this server is configured to use.
   * @returns {number}
   */
  get port () {
    return this._port
  }
}
