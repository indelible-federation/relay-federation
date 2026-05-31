import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

// g-261 IPv6 P2P — filter unroutable IPv6 addresses received via BSV addr exchange.
// Drop unspecified ::, loopback ::1, IPv4-mapped (handled separately by isIPv4
// branch above), link-local fe80::/10, ULA fc00::/7, multicast ff00::/8.
// Global unicast (2000::/3) and everything else routable passes through.
// raw is a 16-byte Buffer holding the BSV addr-message IP field.
function isRoutableIPv6 (raw) {
  if (raw.equals(Buffer.alloc(16))) return false                                  // ::
  if (raw.slice(0, 15).equals(Buffer.alloc(15)) && raw[15] === 1) return false    // ::1
  if (raw[10] === 0xff && raw[11] === 0xff) return false                          // IPv4-mapped
  if (raw[0] === 0xfe && (raw[1] & 0xc0) === 0x80) return false                   // fe80::/10
  if ((raw[0] & 0xfe) === 0xfc) return false                                      // fc00::/7
  if (raw[0] === 0xff) return false                                               // ff00::/8
  return true
}

// g-261 IPv6 P2P — format 16 raw bytes as colon-separated 4-hex groups.
// Pack #2 V3: validate input is a 16-byte Buffer. Returns null on bad input
// so callers can skip rather than crash on readUInt16BE OOB.
function formatIPv6 (raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 16) return null
  const groups = []
  for (let i = 0; i < 16; i += 2) {
    groups.push(raw.readUInt16BE(i).toString(16).padStart(4, '0'))
  }
  return groups.join(':')
}

/**
 * BSVPeer — single TCP connection to a BSV full node.
 *
 * Speaks the Bitcoin P2P protocol (version 70016) for:
 * - Header synchronisation via getheaders/headers
 * - Transaction broadcast via inv/getdata/tx (correct 3-step flow)
 * - Transaction fetch via getdata MSG_TX
 * - Keepalive via ping/pong
 *
 * Ported from production Indelible SPV bridge (p2p.js) with:
 * - Protocol version 70016 with protoconf
 * - User agent /Bitcoin SV:1.1.0/ (matches known clients)
 * - Correct inv-based broadcast (not raw tx push)
 * - Settled flag pattern on connect (no double-reject)
 * - ESM (not CJS)
 *
 * Events:
 *   'headers'      — { headers: [...], count }
 *   'connected'    — { host, port }
 *   'handshake'    — { version, userAgent, startHeight }
 *   'disconnected' — { host, port }
 *   'error'        — Error
 *   'tx'           — { txid, rawHex }
 *   'tx:inv'       — { txids }
 */

// BSV mainnet magic bytes
const MAGIC = Buffer.from('e3e1f3e8', 'hex')
const PROTOCOL_VERSION = 70016
const USER_AGENT = '/Bitcoin SV:1.2.1/'
const HEADER_BYTES = 80
const MSG_HEADER_SIZE = 24

/** Double SHA-256 */
function sha256d (data) {
  const h1 = createHash('sha256').update(data).digest()
  return createHash('sha256').update(h1).digest()
}

/** Reverse a buffer (for hash display conversion) */
function reverseBuffer (buf) {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[buf.length - 1 - i]
  }
  return out
}

/** Convert display hash to internal byte order buffer */
function hashToInternal (hexStr) {
  return reverseBuffer(Buffer.from(hexStr, 'hex'))
}

/** Convert internal byte order buffer to display hash */
function internalToHash (buf) {
  return reverseBuffer(buf).toString('hex')
}

/** Read a variable-length integer from buffer at offset */
function readVarInt (buf, offset) {
  const first = buf[offset]
  if (first < 0xfd) return { value: first, size: 1 }
  if (first === 0xfd) return { value: buf.readUInt16LE(offset + 1), size: 3 }
  if (first === 0xfe) return { value: buf.readUInt32LE(offset + 1), size: 5 }
  return { value: Number(buf.readBigUInt64LE(offset + 1)), size: 9 }
}

/** Write a variable-length integer to buffer */
function writeVarInt (buf, offset, value) {
  if (value < 0xfd) {
    buf[offset] = value
    return 1
  }
  if (value <= 0xffff) {
    buf[offset] = 0xfd
    buf.writeUInt16LE(value, offset + 1)
    return 3
  }
  if (value <= 0xffffffff) {
    buf[offset] = 0xfe
    buf.writeUInt32LE(value, offset + 1)
    return 5
  }
  buf[offset] = 0xff
  buf.writeBigUInt64LE(BigInt(value), offset + 1)
  return 9
}

/** Write a network address (26 bytes) */
function writeNetAddr (buf, offset, services = 1n, ip = '127.0.0.1', port = 8333) {
  buf.writeBigUInt64LE(services, offset)
  buf.fill(0, offset + 8, offset + 20)
  buf[offset + 18] = 0xff
  buf[offset + 19] = 0xff
  const parts = ip.split('.').map(Number)
  buf[offset + 20] = parts[0] || 0
  buf[offset + 21] = parts[1] || 0
  buf[offset + 22] = parts[2] || 0
  buf[offset + 23] = parts[3] || 0
  buf.writeUInt16BE(port, offset + 24)
  return 26
}

// Default checkpoint: block 930,000
const DEFAULT_CHECKPOINT = {
  height: 930000,
  hash: '00000000000000001c2e04e4375cfa4b46588aa27795b2c7f8d4d34cb568a382',
  prevHash: '000000000000000015ec9abde40c7537fc422e5af81b6028ac376d7cf23bd0c8'
}

export class BSVPeer extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {{ height: number, hash: string, prevHash: string }} [opts.checkpoint]
   * @param {number} [opts.syncIntervalMs] — Header sync interval (default 30s)
   * @param {number} [opts.pingIntervalMs] — Keepalive ping interval (default 120s)
   * @param {Map} [opts.headerHashes] — Shared height→hash Map (from BSVNodeClient)
   * @param {Map} [opts.hashToHeight] — Shared hash→height Map (from BSVNodeClient)
   */
  constructor (opts = {}) {
    super()
    this._checkpoint = opts.checkpoint || DEFAULT_CHECKPOINT
    this._syncIntervalMs = opts.syncIntervalMs || 30000
    this._pingIntervalMs = opts.pingIntervalMs || 120000

    this._socket = null
    this._buffer = Buffer.alloc(0)
    this._connected = false
    this._handshakeComplete = false
    this._destroyed = false
    this._host = null
    this._port = null
    this._inbound = false
    this._versionSent = false

    this._syncTimer = null
    this._pingTimer = null

    // Header tracking — use shared Maps if provided, otherwise create own
    this._bestHeight = this._checkpoint.height
    this._bestHash = this._checkpoint.hash
    if (opts.headerHashes && opts.hashToHeight) {
      this._headerHashes = opts.headerHashes
      this._hashToHeight = opts.hashToHeight
    } else {
      this._headerHashes = new Map()
      this._hashToHeight = new Map()
      this._headerHashes.set(this._checkpoint.height, this._checkpoint.hash)
      this._hashToHeight.set(this._checkpoint.hash, this._checkpoint.height)
      if (this._checkpoint.prevHash) {
        this._headerHashes.set(this._checkpoint.height - 1, this._checkpoint.prevHash)
        this._hashToHeight.set(this._checkpoint.prevHash, this._checkpoint.height - 1)
      }
    }

    // Peer info
    this._peerVersion = 0
    this._peerUserAgent = ''
    this._peerStartHeight = 0

    this._syncing = false

    // Transaction tracking
    this._pendingTxRequests = new Map()
    this._pendingBroadcasts = new Map()
    // g-254: track the fired-and-forgotten 60s expiry timers from broadcastTx
    // so _releaseResources can cancel them on disconnect — otherwise the timer
    // closure captures `this` and pins the peer in external memory.
    this._broadcastTimers = new Set()
    this._sharedTxCache = opts.sharedTxCache || null
  }

  /**
   * Accept an inbound connection from a remote BSV node.
   * The remote peer connected to us — we already have the socket.
   * Protocol: they send version → we send version + verack → they send verack → handshake.
   *
   * @param {import('node:net').Socket} socket — already-connected TCP socket
   * @param {string} host — remote IP
   * @param {number} [port=8333]
   * @returns {Promise<{ version, userAgent, startHeight }>}
   */
  async acceptInbound (socket, host, port = 8333) {
    if (this._destroyed) throw new Error('peer destroyed')
    this._host = host
    this._port = port
    this._inbound = true
    this._socket = socket
    this._connected = true

    return new Promise((resolve, reject) => {
      this._socket.on('data', (data) => this._onData(data))

      const onError = (err) => {
        clearTimeout(timer)
        this.removeListener('handshake', onHandshake)
        this._connected = false
        reject(err)
      }

      const onHandshake = (info) => {
        clearTimeout(timer)
        if (this._socket) this._socket.removeListener('error', onError)
        if (this._socket) {
          this._socket.on('error', (err) => {
            this.emit('error', err)
          })
        }
        resolve(info)
      }

      const onTimeout = () => {
        if (this._socket) this._socket.removeListener('error', onError)
        this.removeListener('handshake', onHandshake)
        this.disconnect()
        reject(new Error('Inbound handshake timeout (10s)'))
      }

      this._socket.once('error', onError)
      this._socket.on('close', () => this._onDisconnect())
      this.once('handshake', onHandshake)
      const timer = setTimeout(onTimeout, 10000)
      // Don't send version yet — wait for their version first (handled in _onVersion)
    })
  }

  /**
   * Connect to a BSV node at host:port.
   * Returns a Promise that resolves on successful handshake.
   * Uses settled flag pattern to prevent double-reject.
   *
   * @param {string} host — IP address
   * @param {number} [port=8333]
   * @returns {Promise<{ version, userAgent, startHeight }>}
   */
  async connect (host, port = 8333) {
    if (this._destroyed) throw new Error('peer destroyed')
    this._host = host
    this._port = port

    return new Promise((resolve, reject) => {
      this._socket = createConnection({ host, port })

      this._socket.on('connect', () => {
        this._connected = true
        this.emit('connected', { host, port })
        this._sendVersion()
      })

      this._socket.on('data', (data) => this._onData(data))

      // Settled pattern: whichever fires first wins, others are no-ops
      const onError = (err) => {
        clearTimeout(timer)
        this.removeListener('handshake', onHandshake)
        this._connected = false
        reject(err)
      }

      const onHandshake = (info) => {
        clearTimeout(timer)
        if (this._socket) this._socket.removeListener('error', onError)
        // Replace with soft error handler post-handshake
        if (this._socket) {
          this._socket.on('error', (err) => {
            this.emit('error', err)
          })
        }
        resolve(info)
      }

      const onTimeout = () => {
        if (this._socket) this._socket.removeListener('error', onError)
        this.removeListener('handshake', onHandshake)
        this.disconnect()
        reject(new Error('Handshake timeout (10s)'))
      }

      this._socket.once('error', onError)
      this._socket.on('close', () => this._onDisconnect())
      this.once('handshake', onHandshake)
      const timer = setTimeout(onTimeout, 10000)
    })
  }

  /**
   * Disconnect and stop all timers.
   */
  disconnect () {
    this._destroyed = true
    clearInterval(this._syncTimer)
    clearInterval(this._pingTimer)
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    this._connected = false
    this._handshakeComplete = false
    this._releaseResources()
  }

  /**
   * Release per-peer C-allocated buffers + pending request state to prevent
   * V8 retention leaks on peer churn (g-254).
   *
   * Why: when a peer disconnects — especially during the "dropped before
   * handshake" storm against banned/incompatible peers — the parent's
   * this._peers.delete(host) removes its Map reference, but lingering
   * closures (in-flight pending-tx Promise resolvers, accumulated socket
   * Buffer, cached broadcast rawHex) can keep the peer object alive via
   * V8 retention. Explicitly dropping those heavy fields breaks the
   * retention chain so V8 can free the C-allocated bytes.
   *
   * Safe to call multiple times (idempotent). Safe to call before disconnect.
   * Setting _buffer to a fresh empty Buffer (not null) keeps _onData's
   * Buffer.concat path crash-safe if a late socket event arrives post-release.
   */
  _releaseResources () {
    this._buffer = Buffer.alloc(0)
    for (const { reject, timer } of this._pendingTxRequests.values()) {
      clearTimeout(timer)
      try { reject(new Error('peer disconnected')) } catch {}
    }
    this._pendingTxRequests.clear()
    this._pendingBroadcasts.clear()
    for (const timer of this._broadcastTimers) clearTimeout(timer)
    this._broadcastTimers.clear()
  }

  /**
   * Request header sync from current best height.
   */
  syncHeaders () {
    if (!this._handshakeComplete || this._syncing) return
    this._syncing = true
    const locator = this._buildBlockLocator()
    this._sendGetHeaders(locator)
  }

  /**
   * Seed a known header hash.
   * @param {number} height
   * @param {string} hash — display-format hex
   */
  seedHeader (height, hash) {
    this._headerHashes.set(height, hash)
    this._hashToHeight.set(hash, height)
    if (height > this._bestHeight) {
      this._bestHeight = height
      this._bestHash = hash
    }
  }

  /**
   * Request peer addresses from this peer (getaddr P2P message).
   * Peer responds with 'addr' message containing known node IPs.
   */
  requestAddr () {
    if (this._handshakeComplete) {
      this._sendMessage('getaddr', Buffer.alloc(0))
    }
  }

  /**
   * Advertise our own address to this peer via the addr P2P message.
   * Peers gossip received addresses to their peers, making us discoverable.
   * @param {string} ip — our public IPv4 address
   * @param {number} [port=8333]
   */
  sendSelfAddr (ip, port = 8333) {
    if (!this._handshakeComplete) return
    // addr message: varint count + (4 timestamp + 8 services + 16 IP + 2 port) per entry
    const payload = Buffer.alloc(1 + 30)
    let o = 0
    payload[o++] = 1 // count = 1
    const now = Math.floor(Date.now() / 1000)
    payload.writeUInt32LE(now, o); o += 4
    payload.writeBigUInt64LE(1n, o); o += 8 // services = NODE_NETWORK
    // IPv4-mapped IPv6
    payload.fill(0, o, o + 10); o += 10
    payload[o++] = 0xff
    payload[o++] = 0xff
    const parts = ip.split('.').map(Number)
    payload[o++] = parts[0]
    payload[o++] = parts[1]
    payload[o++] = parts[2]
    payload[o++] = parts[3]
    payload.writeUInt16BE(port, o); o += 2
    this._sendMessage('addr', payload.subarray(0, o))
  }

  /**
   * Fetch a transaction by txid from this peer.
   * @param {string} txid
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{ txid, rawHex }>}
   */
  getTx (txid, timeoutMs = 10000) {
    if (!this._handshakeComplete) {
      return Promise.reject(new Error('not connected to BSV node'))
    }
    if (this._pendingTxRequests.has(txid)) {
      return Promise.reject(new Error(`already fetching tx ${txid.slice(0, 16)}...`))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingTxRequests.delete(txid)
        reject(new Error(`timeout fetching tx ${txid.slice(0, 16)}...`))
      }, timeoutMs)

      this._pendingTxRequests.set(txid, { resolve, reject, timer })

      const payload = Buffer.alloc(37)
      payload[0] = 1
      payload.writeUInt32LE(1, 1)
      hashToInternal(txid).copy(payload, 5)
      this._sendMessage('getdata', payload)
    })
  }

  /**
   * Broadcast a raw transaction using correct inv/getdata/tx flow.
   * Sends inv announcement; peers respond with getdata; we serve the tx.
   *
   * @param {string} rawTxHex
   * @returns {string} txid (display format)
   */
  broadcastTx (rawTxHex) {
    const txBuffer = Buffer.from(rawTxHex, 'hex')
    const txid = internalToHash(sha256d(txBuffer))

    // Store so we can serve getdata requests from peers
    this._pendingBroadcasts.set(txid, rawTxHex)
    // g-254: track the timer so _releaseResources can cancel it on disconnect.
    // Without tracking, the arrow-function closure captures `this` and keeps
    // the peer alive in external memory for up to 60s after disconnect.
    const expiryTimer = setTimeout(() => {
      this._pendingBroadcasts.delete(txid)
      this._broadcastTimers.delete(expiryTimer)
    }, 60000)
    this._broadcastTimers.add(expiryTimer)

    // Send inv to announce we have this tx
    const invPayload = Buffer.alloc(37)
    invPayload[0] = 1 // count = 1
    invPayload.writeUInt32LE(1, 1) // MSG_TX = 1
    hashToInternal(txid).copy(invPayload, 5)
    this._sendMessage('inv', invPayload)

    return txid
  }

  /**
   * Relay an inv announcement for a txid we don't have the raw hex for yet.
   * Used for immediate inv relay — getdata will be served from sharedTxCache.
   * @param {string} txid — display-format txid
   */
  relayInv (txid) {
    const invPayload = Buffer.alloc(37)
    invPayload[0] = 1 // count = 1
    invPayload.writeUInt32LE(1, 1) // MSG_TX = 1
    hashToInternal(txid).copy(invPayload, 5)
    this._sendMessage('inv', invPayload)
  }

  /**
   * Push a raw transaction directly (no inv/getdata dance).
   * More reliable for one-shot broadcasts from short-lived connections.
   *
   * @param {string} rawTxHex
   * @returns {string} txid (display format)
   */
  pushTx (rawTxHex) {
    const txBuffer = Buffer.from(rawTxHex, 'hex')
    const txid = internalToHash(sha256d(txBuffer))
    this._sendMessage('tx', txBuffer)
    return txid
  }

  /**
   * Request full tx data for multiple txids via batch getdata.
   * Responses arrive as 'tx' events from _onTx handler.
   * @param {string[]} txids — display-format txids
   */
  requestTxs (txids) {
    if (!this._handshakeComplete || txids.length === 0) return
    const count = txids.length
    const payloadSize = 9 + count * 36 // varint + (type + hash) per entry
    const payload = Buffer.alloc(payloadSize)
    const viSize = writeVarInt(payload, 0, count)
    let offset = viSize
    for (const txid of txids) {
      payload.writeUInt32LE(1, offset) // MSG_TX = 1
      hashToInternal(txid).copy(payload, offset + 4)
      offset += 36
    }
    this._sendMessage('getdata', payload.subarray(0, offset))
  }

  /** Current best height */
  get bestHeight () { return this._bestHeight }
  /** Current best hash */
  get bestHash () { return this._bestHash }
  /** Connected host */
  get host () { return this._host }

  // ── Private: connection management ─────────────────────────

  _onDisconnect () {
    const host = this._host
    const wasHandshaked = this._handshakeComplete
    this._connected = false
    this._handshakeComplete = false
    this._syncing = false
    clearInterval(this._syncTimer)
    clearInterval(this._pingTimer)
    this._syncTimer = null
    this._pingTimer = null
    if (!wasHandshaked) {
      console.log(`[P2P] ${host}:${this._port} dropped before handshake (banned or incompatible)`)
    }
    this._releaseResources()
    this.emit('disconnected', { host, port: this._port })
  }

  // ── Private: data parsing ──────────────────────────────────

  _onData (data) {
    if (this._destroyed) return
    this._buffer = Buffer.concat([this._buffer, data])
    if (!this._draining) this._drainBuffer()
  }

  _drainBuffer () {
    this._draining = true
    let processed = 0
    const MAX_PER_TICK = 10
    let checksumFails = 0
    const MAX_CHECKSUM_FAILS = 20

    while (this._buffer.length >= MSG_HEADER_SIZE && !this._destroyed) {
      const magicIdx = this._findMagic()
      if (magicIdx < 0) {
        this._buffer = Buffer.alloc(0)
        this._draining = false
        return
      }
      if (magicIdx > 0) {
        this._buffer = this._buffer.subarray(magicIdx)
      }

      if (this._buffer.length < MSG_HEADER_SIZE) { this._draining = false; return }

      const command = this._buffer.subarray(4, 16).toString('ascii').replace(/\0/g, '')
      const payloadLen = this._buffer.readUInt32LE(16)
      const checksum = this._buffer.subarray(20, 24)

      const totalLen = MSG_HEADER_SIZE + payloadLen
      if (this._buffer.length < totalLen) { this._draining = false; return }

      const payload = this._buffer.subarray(MSG_HEADER_SIZE, totalLen)

      const computed = sha256d(payload).subarray(0, 4)
      if (!computed.equals(checksum)) {
        this._buffer = this._buffer.subarray(4)
        checksumFails++
        if (checksumFails >= MAX_CHECKSUM_FAILS) {
          // Too many checksum failures — drop buffer to prevent CPU spin
          this._buffer = Buffer.alloc(0)
          this._draining = false
          return
        }
        continue
      }

      checksumFails = 0
      this._buffer = this._buffer.subarray(totalLen)

      try {
        this._handleMessage(command, payload)
      } catch (err) {
        this.emit('error', err)
      }

      processed++
      if (processed >= MAX_PER_TICK && this._buffer.length >= MSG_HEADER_SIZE) {
        // Yield to event loop — let pongs, timers, HTTP run
        setImmediate(() => this._drainBuffer())
        return
      }
    }
    this._draining = false
  }

  _findMagic () {
    for (let i = 0; i <= this._buffer.length - 4; i++) {
      if (this._buffer[i] === MAGIC[0] &&
          this._buffer[i + 1] === MAGIC[1] &&
          this._buffer[i + 2] === MAGIC[2] &&
          this._buffer[i + 3] === MAGIC[3]) {
        return i
      }
    }
    return -1
  }

  // ── Private: message handling ──────────────────────────────

  _handleMessage (command, payload) {
    if (this._destroyed) return
    switch (command) {
      case 'version':
        this._onVersion(payload)
        break
      case 'verack':
        this._onVerack()
        break
      case 'headers':
        this._onHeaders(payload)
        break
      case 'inv':
        this._onInv(payload)
        break
      case 'ping':
        this._onPing(payload)
        break
      case 'tx':
        this._onTx(payload)
        break
      case 'notfound':
        this._onNotfound(payload)
        break
      case 'getdata':
        this._onGetdata(payload)
        break
      case 'getheaders':
        this._onGetheaders(payload)
        break
      case 'addr':
        this._onAddr(payload)
        break
      case 'sendheaders':
      case 'sendcmpct':
      case 'feefilter':
      case 'protoconf':
      case 'authch':
      case 'authresp':
      case 'extmsg':
        break
    }
  }

  _onVersion (payload) {
    this._peerVersion = payload.readInt32LE(0)
    const userAgentLen = readVarInt(payload, 80)
    this._peerUserAgent = payload.subarray(80 + userAgentLen.size, 80 + userAgentLen.size + userAgentLen.value).toString('ascii')
    const heightOffset = 80 + userAgentLen.size + userAgentLen.value
    if (heightOffset + 4 <= payload.length) {
      this._peerStartHeight = payload.readInt32LE(heightOffset)
    }

    // Only connect to BSV nodes — reject BTC/BCH
    if (!this._peerUserAgent.includes('Bitcoin SV')) {
      this.disconnect()
      return
    }

    // For inbound connections, send our version now (they initiated)
    if (this._inbound && !this._versionSent) {
      this._sendVersion()
    }

    this._sendMessage('verack', Buffer.alloc(0))
  }

  _onVerack () {
    if (this._destroyed) return
    this._handshakeComplete = true

    // Send protoconf (protocol 70016+) — advertise max payload size
    this._sendProtoconf()

    this.emit('handshake', {
      version: this._peerVersion,
      userAgent: this._peerUserAgent,
      startHeight: this._peerStartHeight
    })

    // Start header sync
    this.syncHeaders()

    // Periodic sync for new blocks
    this._syncTimer = setInterval(() => {
      this.syncHeaders()
    }, this._syncIntervalMs)
    if (this._syncTimer.unref) this._syncTimer.unref()

    // Keep-alive pings
    this._pingTimer = setInterval(() => {
      this._sendPing()
    }, this._pingIntervalMs)
    if (this._pingTimer.unref) this._pingTimer.unref()
  }

  _onHeaders (payload) {
    this._syncing = false

    if (payload.length === 0) return

    const countInfo = readVarInt(payload, 0)
    const count = countInfo.value
    if (count === 0) return

    let offset = countInfo.size
    const headers = []

    for (let i = 0; i < count; i++) {
      if (offset + HEADER_BYTES > payload.length) break

      const rawHeader = payload.subarray(offset, offset + HEADER_BYTES)

      const version = rawHeader.readInt32LE(0)
      const prevHashBuf = rawHeader.subarray(4, 36)
      const merkleRootBuf = rawHeader.subarray(36, 68)
      const timestamp = rawHeader.readUInt32LE(68)
      const bits = rawHeader.readUInt32LE(72)
      const nonce = rawHeader.readUInt32LE(76)

      const blockHash = internalToHash(sha256d(rawHeader))
      const prevHash = internalToHash(prevHashBuf)

      const prevHeight = this._hashToHeight.get(prevHash)
      let height = prevHeight !== undefined ? prevHeight + 1 : -1

      if (height < 0) {
        offset += HEADER_BYTES
        if (offset < payload.length) {
          const txCount = readVarInt(payload, offset)
          offset += txCount.size
        }
        continue
      }

      this._headerHashes.set(height, blockHash)
      this._hashToHeight.set(blockHash, height)
      if (height > this._bestHeight) {
        this._bestHeight = height
        this._bestHash = blockHash
      }

      headers.push({
        height,
        hash: blockHash,
        prevHash,
        timestamp,
        bits,
        nonce,
        version,
        merkleRoot: internalToHash(merkleRootBuf)
      })

      offset += HEADER_BYTES

      if (offset < payload.length) {
        const txCount = readVarInt(payload, offset)
        offset += txCount.size
      }
    }

    if (headers.length > 0) {
      this.emit('headers', { headers, count: headers.length })

      if (count >= 2000) {
        this.syncHeaders()
      }
    }
  }

  _onInv (payload) {
    if (payload.length < 1) return

    const countInfo = readVarInt(payload, 0)
    let offset = countInfo.size
    let hasBlock = false
    const txids = []

    for (let i = 0; i < countInfo.value; i++) {
      if (offset + 36 > payload.length) break
      const invType = payload.readUInt32LE(offset)
      const hashBuf = payload.subarray(offset + 4, offset + 36)

      if (invType === 2) {
        hasBlock = true
      } else if (invType === 1) {
        txids.push(internalToHash(hashBuf))
      }
      offset += 36
    }

    if (hasBlock) {
      this.syncHeaders()
    }

    if (txids.length > 0) {
      this.emit('tx:inv', { txids, peer: this })
    }
  }

  _onPing (payload) {
    this._sendMessage('pong', payload)
  }

  _onGetheaders (payload) {
    // BSV 1.2.x peers ask us for headers; reply with empty headers (count=0)
    // so they don't drop us. We're a bridge, not a header server.
    const reply = Buffer.from([0x00]) // varint: 0 headers
    this._sendMessage('headers', reply)
  }

  _onAddr (payload) {
    if (payload.length < 1) return
    const countInfo = readVarInt(payload, 0)
    const count = countInfo.value
    let offset = countInfo.size
    const addrs = []

    for (let i = 0; i < count && offset + 30 <= payload.length; i++) {
      // 4 bytes timestamp + 8 bytes services + 16 bytes IP + 2 bytes port
      offset += 4 // skip timestamp
      offset += 8 // skip services

      // IPv4-mapped IPv6: last 4 bytes of 16-byte IP field
      const isIPv4 = payload[offset + 10] === 0xff && payload[offset + 11] === 0xff
      if (isIPv4) {
        const host = `${payload[offset + 12]}.${payload[offset + 13]}.${payload[offset + 14]}.${payload[offset + 15]}`
        offset += 16
        const port = payload.readUInt16BE(offset)
        offset += 2
        if (port === 8333 && host !== '0.0.0.0' && host !== '127.0.0.1') {
          addrs.push({ host, port })
        }
      } else {
        // g-261 IPv6 P2P: parse native IPv6 address from 16-byte field.
        // Defensive bounds check (outer loop guard already enforces this, but
        // explicit for clarity + future-proofing against loop restructure).
        if (offset + 16 + 2 > payload.length) break
        const raw = payload.slice(offset, offset + 16)
        offset += 16
        const port = payload.readUInt16BE(offset)
        offset += 2
        if (port === 8333 && isRoutableIPv6(raw)) {
          const host = formatIPv6(raw)
          // Pack #2 V3: formatIPv6 returns null on bad input; skip rather than push null host
          if (host !== null) addrs.push({ host, port })
        }
      }
    }

    if (addrs.length > 0) {
      this.emit('addr', { addrs })
    }
  }

  _onTx (payload) {
    const txid = internalToHash(sha256d(payload))
    const rawHex = payload.toString('hex')
    this.emit('tx', { txid, rawHex })

    const pending = this._pendingTxRequests.get(txid)
    if (pending) {
      clearTimeout(pending.timer)
      this._pendingTxRequests.delete(txid)
      pending.resolve({ txid, rawHex })
    }
  }

  _onNotfound (payload) {
    if (payload.length < 1) return
    const countInfo = readVarInt(payload, 0)
    let offset = countInfo.size

    for (let i = 0; i < countInfo.value; i++) {
      if (offset + 36 > payload.length) break
      const invType = payload.readUInt32LE(offset)
      const hashBuf = payload.subarray(offset + 4, offset + 36)
      offset += 36

      if (invType === 1) {
        const txid = internalToHash(hashBuf)
        const pending = this._pendingTxRequests.get(txid)
        if (pending) {
          clearTimeout(pending.timer)
          this._pendingTxRequests.delete(txid)
          pending.reject(new Error(`tx not found: ${txid.slice(0, 16)}...`))
        }
      }
    }
  }

  _onGetdata (payload) {
    if (payload.length < 1) return
    const countInfo = readVarInt(payload, 0)
    let offset = countInfo.size

    for (let i = 0; i < countInfo.value; i++) {
      if (offset + 36 > payload.length) break
      const invType = payload.readUInt32LE(offset)
      const hashBuf = payload.subarray(offset + 4, offset + 36)
      offset += 36

      if (invType === 1) {
        const txid = internalToHash(hashBuf)
        const rawHex = this._pendingBroadcasts.get(txid) || (this._sharedTxCache && this._sharedTxCache.get(txid))
        if (rawHex) {
          this._sendMessage('tx', Buffer.from(rawHex, 'hex'))
          this._pendingBroadcasts.delete(txid)
          this.emit('tx:broadcast', txid)
          console.log(`[P2P novel-relay] ${txid.slice(0, 12)}... accepted by peer`)
        }
      }
    }
  }

  // ── Private: message building ──────────────────────────────

  _sendMessage (command, payload) {
    if (!this._socket || !this._connected || this._socket.destroyed) return

    const header = Buffer.alloc(MSG_HEADER_SIZE)
    MAGIC.copy(header, 0)
    const cmdBuf = Buffer.alloc(12)
    cmdBuf.write(command, 'ascii')
    cmdBuf.copy(header, 4)
    header.writeUInt32LE(payload.length, 16)
    const checksum = sha256d(payload).subarray(0, 4)
    checksum.copy(header, 20)

    this._socket.write(Buffer.concat([header, payload]))
  }

  _sendVersion () {
    this._versionSent = true
    const userAgentBuf = Buffer.from(USER_AGENT, 'ascii')
    const payloadSize = 4 + 8 + 8 + 26 + 26 + 8 + 1 + userAgentBuf.length + 4 + 1
    const payload = Buffer.alloc(payloadSize)
    let offset = 0

    payload.writeInt32LE(PROTOCOL_VERSION, offset); offset += 4
    payload.writeBigUInt64LE(1n, offset); offset += 8 // services = NODE_NETWORK (required to not get dropped)
    const now = BigInt(Math.floor(Date.now() / 1000))
    payload.writeBigUInt64LE(now, offset); offset += 8
    offset += writeNetAddr(payload, offset, 1n, this._host || '127.0.0.1', this._port || 8333)
    offset += writeNetAddr(payload, offset, 0n, '0.0.0.0', 0)
    randomBytes(8).copy(payload, offset); offset += 8
    offset += writeVarInt(payload, offset, userAgentBuf.length)
    userAgentBuf.copy(payload, offset); offset += userAgentBuf.length
    payload.writeInt32LE(this._bestHeight, offset); offset += 4
    payload[offset] = 1; offset += 1

    this._sendMessage('version', payload.subarray(0, offset))
  }

  /**
   * Send protoconf (protocol 70016+) — advertise max receive payload size.
   */
  _sendProtoconf () {
    const payload = Buffer.alloc(16) // oversized, will slice
    let offset = 0
    offset += writeVarInt(payload, offset, 2) // numberOfFields = 2
    offset += writeVarInt(payload, offset, 2 * 1024 * 1024) // field1: maxRecvPayloadLength = 2MB (varint)
    offset += writeVarInt(payload, offset, 0) // field2: streamPolicies = empty varstr (length 0)
    this._sendMessage('protoconf', payload.subarray(0, offset))
  }

  _sendGetHeaders (locatorHashes) {
    const hashCount = locatorHashes.length
    const varIntBuf = Buffer.alloc(9)
    const varIntSize = writeVarInt(varIntBuf, 0, hashCount)

    const payloadSize = 4 + varIntSize + (hashCount * 32) + 32
    const payload = Buffer.alloc(payloadSize)
    let offset = 0

    payload.writeUInt32LE(PROTOCOL_VERSION, offset); offset += 4
    varIntBuf.copy(payload, offset, 0, varIntSize); offset += varIntSize

    for (const hash of locatorHashes) {
      const hashBuf = hashToInternal(hash)
      hashBuf.copy(payload, offset); offset += 32
    }

    payload.fill(0, offset, offset + 32)

    this._sendMessage('getheaders', payload)
  }

  _sendPing () {
    const payload = Buffer.alloc(8)
    randomBytes(8).copy(payload)
    this._sendMessage('ping', payload)
  }

  // ── Private: block locator ─────────────────────────────────

  _buildBlockLocator () {
    const hashes = []
    let step = 1
    let height = this._bestHeight

    while (height >= this._checkpoint.height) {
      const hash = this._headerHashes.get(height)
      if (hash) {
        hashes.push(hash)
      }
      if (height === this._checkpoint.height) break
      height -= step
      if (height < this._checkpoint.height) {
        height = this._checkpoint.height
      }
      if (hashes.length > 10) {
        step *= 2
      }
    }

    const cpHash = this._headerHashes.get(this._checkpoint.height)
    if (cpHash && hashes[hashes.length - 1] !== cpHash) {
      hashes.push(cpHash)
    }

    return hashes
  }
}
