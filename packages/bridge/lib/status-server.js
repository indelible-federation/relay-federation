import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import https from 'node:https'
import { parseTx } from './output-parser.js'
import { scanAddress } from './address-scanner.js'
import { handlePostData, handleGetTopics, handleGetData } from './data-endpoints.js'

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
    this._store = opts.store || null
    this._performOutboundHandshake = opts.performOutboundHandshake || null
    this._registeredPubkeys = opts.registeredPubkeys || null
    this._gossipManager = opts.gossipManager || null
    this._startedAt = Date.now()
    this._server = null

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
        seen: this._txRelay ? this._txRelay.seen.size : 0
      },
      bsvNode: {
        connected: this._bsvNodeClient ? this._bsvNodeClient.connectedCount > 0 : false,
        peers: this._bsvNodeClient ? this._bsvNodeClient.connectedCount : 0,
        height: this._bsvNodeClient ? this._bsvNodeClient.bestHeight : null
      }
    }

    // Operator-only fields
    if (authenticated) {
      status.operator = true
      status.bridge.endpoint = this._config.endpoint || null
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
  _readBody (req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}) } catch (e) { reject(e) }
      })
      req.on('error', reject)
    })
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
   * Start the HTTP server on localhost.
   * @returns {Promise<void>}
   */
  start () {
    return new Promise((resolve, reject) => {
      this._server = createServer((req, res) => {
        // CORS headers for federation dashboard
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        this._handleRequest(req, res).catch(() => {
          res.writeHead(500)
          res.end('Internal Server Error')
        })
      })

      this._server.listen(this._port, '0.0.0.0', () => resolve())
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
                data: o.data,
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

    // GET /discover — public list of all known bridges in the mesh
    if (req.method === 'GET' && path === '/discover') {
      const bridges = []
      // Add self
      bridges.push({
        name: this._config.name || null,
        pubkeyHex: this._config.pubkeyHex || null,
        endpoint: this._config.endpoint || null,
        meshId: this._config.meshId || null,
        statusUrl: 'http://' + (req.headers.host || '127.0.0.1:' + this._port) + '/status'
      })
      // Add gossip directory (all known peers)
      if (this._gossipManager) {
        for (const peer of this._gossipManager.getDirectory()) {
          // Derive statusUrl from ws endpoint: ws://host:8333 → http://host:9333
          let statusUrl = null
          try {
            const u = new URL(peer.endpoint)
            const statusPort = parseInt(u.port, 10) + 1000
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

    // GET / or /dashboard — built-in HTML dashboard
    if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(DASHBOARD_HTML)
      return
    }

    // POST /broadcast — relay a raw tx to peers
    if (req.method === 'POST' && path === '/broadcast') {
      const body = await this._readBody(req)
      const { rawHex } = body
      if (!rawHex || typeof rawHex !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'rawHex required' }))
        return
      }
      const buf = Buffer.from(rawHex, 'hex')
      const hash = createHash('sha256').update(createHash('sha256').update(buf).digest()).digest()
      const txid = Buffer.from(hash).reverse().toString('hex')
      const sent = this._txRelay ? this._txRelay.broadcastTx(txid, rawHex) : 0
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ txid, peers: sent }))
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

    // POST /register — operator: start async overlay registration (SHIP token)
    if (req.method === 'POST' && path === '/register') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runOverlayRegister } = await import('./actions.js')
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      runOverlayRegister({ config: this._config, store: this._store, overlayUrl: this._config.overlayUrl, log }).catch(err => {
        log('error', err.message)
      })
      return
    }

    // POST /deregister — operator: start async overlay deregistration (revoke SHIP token)
    if (req.method === 'POST' && path === '/deregister') {
      if (!authenticated) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized. Provide statusSecret via ?auth= or Authorization header.' }))
        return
      }
      const { runOverlayDeregister } = await import('./actions.js')
      const { jobId, log } = this._createJob()
      res.writeHead(202, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ jobId, stream: `/jobs/${jobId}` }))
      runOverlayDeregister({ config: this._config, store: this._store, overlayUrl: this._config.overlayUrl, log }).catch(err => {
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

    // GET /address/:addr/history — transaction history for an address (via WoC)
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
        const resp = await fetch('https://api.whatsonchain.com/v1/bsv/main/address/' + addr + '/history', { signal: AbortSignal.timeout(10000) })
        if (!resp.ok) throw new Error('WoC returned ' + resp.status)
        const history = await resp.json()
        this._addressCache.set(addr, { data: history, time: Date.now() })
        // Prune cache if it grows too large
        if (this._addressCache.size > 100) {
          const oldest = this._addressCache.keys().next().value
          this._addressCache.delete(oldest)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ address: addr, history, cached: false }))
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
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

    res.writeHead(404)
    res.end('Not Found')
  }

  /**
   * Stop the HTTP server.
   * @returns {Promise<void>}
   */
  stop () {
    this.stopAppMonitoring()
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
