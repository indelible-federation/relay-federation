import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { PeerConnection } from './peer-connection.js'

/**
 * PeerManager — manages multiple peer connections.
 *
 * Handles:
 * - Outbound connections to discovered peers
 * - Inbound connections from other bridges (via WSS server)
 * - Broadcasting messages to all connected peers
 * - Peer lifecycle (connect, disconnect, reconnect)
 *
 * Events:
 *   'peer:connect'    — { pubkeyHex, endpoint }
 *   'peer:disconnect' — { pubkeyHex, endpoint }
 *   'peer:message'    — { pubkeyHex, message }
 *   'peer:error'      — { pubkeyHex, error }
 */
export class PeerManager extends EventEmitter {
  /**
   * @param {object} [opts]
   */
  constructor () {
    super()
    /** @type {Map<string, PeerConnection>} pubkeyHex → PeerConnection */
    this.peers = new Map()
    this._server = null
  }

  /**
   * Connect to a discovered peer (outbound).
   *
   * @param {object} peer - Peer from buildPeerList()
   * @param {string} peer.pubkeyHex
   * @param {string} peer.endpoint
   * @returns {PeerConnection|null} The connection, or null if already connected
   */
  connectToPeer (peer) {
    if (this.peers.has(peer.pubkeyHex)) {
      return this.peers.get(peer.pubkeyHex)
    }

    const conn = new PeerConnection({
      endpoint: peer.endpoint,
      pubkeyHex: peer.pubkeyHex
    })

    this._attachPeerEvents(conn)
    this.peers.set(peer.pubkeyHex, conn)
    conn.connect()

    return conn
  }

  /**
   * Accept an inbound peer connection.
   *
   * @param {WebSocket} socket - Incoming WebSocket
   * @param {string} pubkeyHex - Peer's pubkey (from handshake)
   * @param {string} endpoint - Peer's advertised endpoint
   * @returns {PeerConnection|null}
   */
  acceptPeer (socket, pubkeyHex, endpoint) {
    if (this.peers.has(pubkeyHex)) {
      // Already connected — close the duplicate
      socket.close()
      return null
    }

    const conn = new PeerConnection({
      endpoint,
      pubkeyHex,
      socket
    })

    this._attachPeerEvents(conn)
    this.peers.set(pubkeyHex, conn)

    return conn
  }

  /**
   * Disconnect a specific peer.
   *
   * @param {string} pubkeyHex
   */
  disconnectPeer (pubkeyHex) {
    const conn = this.peers.get(pubkeyHex)
    if (conn) {
      conn.destroy()
      this.peers.delete(pubkeyHex)
    }
  }

  /**
   * Broadcast a message to all connected peers.
   *
   * @param {object} msg - JSON message with `type` field
   * @param {string} [excludePubkey] - Optional pubkey to exclude (e.g. message source)
   * @returns {number} Number of peers the message was sent to
   */
  broadcast (msg, excludePubkey) {
    let sent = 0
    for (const [pubkeyHex, conn] of this.peers) {
      if (pubkeyHex === excludePubkey) continue
      if (conn.send(msg)) sent++
    }
    return sent
  }

  /**
   * Get count of currently connected peers.
   * @returns {number}
   */
  connectedCount () {
    let count = 0
    for (const conn of this.peers.values()) {
      if (conn.connected) count++
    }
    return count
  }

  /**
   * Start a WebSocket server for inbound connections.
   *
   * @param {object} opts
   * @param {number} opts.port - Port to listen on
   * @param {string} [opts.host='0.0.0.0'] - Host to bind to
   * @param {boolean} [opts.startGossipListener] - When strictly === false, skip
   *   the inbound WebSocket server entirely (g-192 V3 personal mode). Defaults
   *   to running. The caller (cli.js applyModeDefaults) owns the default.
   * @returns {Promise<void>}
   */
  startServer (opts) {
    // g-192 V3: dumb-executor gate. cli.js applyModeDefaults sets this to false
    // in personal mode; we never default it here (R2 pack catch — defaulting
    // ?? true would silently re-enable gossip and defeat --personal).
    if (opts.startGossipListener === false) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this._server = new WebSocketServer({
        port: opts.port,
        host: opts.host || '0.0.0.0',
        perMessageDeflate: opts.perMessageDeflate ?? false
      })

      this._server.on('listening', () => resolve())
      this._server.on('error', (err) => reject(err))

      this._server.on('connection', (ws, req) => {
        const remote = req?.socket?.remoteAddress || 'unknown'
        console.log(`[ws-in] ${remote} extensions="${ws.extensions || ''}"`)
        // Inbound connections: full challenge-response handshake if available,
        // otherwise fall back to basic hello exchange.
        const timeout = setTimeout(() => {
          ws.close() // No hello within 10 seconds
        }, 10000)

        ws.once('message', (data) => {
          clearTimeout(timeout)
          try {
            const msg = JSON.parse(data.toString())
            if (msg.type !== 'hello' || !msg.pubkey || !msg.endpoint) {
              ws.close()
              return
            }

            // If cryptographic handshake is available, use it
            if (opts.handshake && msg.nonce && Array.isArray(msg.versions)) {
              const isSeed = opts.seedEndpoints && opts.seedEndpoints.has(msg.endpoint)
              const result = opts.handshake.handleHello(msg, isSeed ? null : opts.registeredPubkeys)
              if (result.error) {
                ws.send(JSON.stringify({ type: 'error', error: result.error }))
                ws.close()
                return
              }

              // Send challenge_response
              ws.send(JSON.stringify(result.message))

              // Wait for verify
              const verifyTimeout = setTimeout(() => { ws.close() }, 10000)
              ws.once('message', (data2) => {
                clearTimeout(verifyTimeout)
                try {
                  const verifyMsg = JSON.parse(data2.toString())
                  const verifyResult = opts.handshake.handleVerify(verifyMsg, result.nonce, result.peerPubkey)
                  if (verifyResult.error) {
                    ws.send(JSON.stringify({ type: 'error', error: verifyResult.error }))
                    ws.close()
                    return
                  }

                  // Tie-break duplicate connections by pubkey
                  const existing = this.peers.get(result.peerPubkey)
                  if (existing) {
                    // If existing connection is dead (reconnecting), prefer new working connection
                    if (!existing.connected) {
                      existing._shouldReconnect = false
                      existing.destroy()
                      this.peers.delete(result.peerPubkey)
                    } else if (opts.pubkeyHex < result.peerPubkey) {
                      // Lower pubkey keeps outbound — reject this inbound
                      ws.close()
                      return
                    } else {
                      // Higher pubkey keeps inbound — drop existing outbound
                      existing._shouldReconnect = false
                      existing.destroy()
                      this.peers.delete(result.peerPubkey)
                    }
                  }

                  // Handshake complete — accept peer
                  // Learn seed pubkeys so they pass registry check on future connections
                  if (isSeed && opts.registeredPubkeys && !opts.registeredPubkeys.has(result.peerPubkey)) {
                    opts.registeredPubkeys.add(result.peerPubkey)
                  }
                  const conn = this.acceptPeer(ws, result.peerPubkey, msg.endpoint)
                  if (conn) {
                    this.emit('peer:connect', { pubkeyHex: result.peerPubkey, endpoint: msg.endpoint })
                    conn.emit('message', msg)
                  }
                } catch {
                  ws.close()
                }
              })
            } else {
              // Legacy hello — accept without crypto verification
              const conn = this.acceptPeer(ws, msg.pubkey, msg.endpoint)
              if (conn) {
                if (opts.pubkeyHex && opts.endpoint) {
                  ws.send(JSON.stringify({
                    type: 'hello',
                    pubkey: opts.pubkeyHex,
                    endpoint: opts.endpoint
                  }))
                }
                this.emit('peer:connect', { pubkeyHex: msg.pubkey, endpoint: msg.endpoint })
                conn.emit('message', msg)
              }
            }
          } catch {
            ws.close()
          }
        })
      })
    })
  }

  /**
   * Stop the WebSocket server and disconnect all peers.
   */
  async shutdown () {
    for (const [pubkeyHex, conn] of this.peers) {
      conn.destroy()
    }
    this.peers.clear()

    if (this._server) {
      await new Promise(resolve => this._server.close(resolve))
      this._server = null
    }
  }

  _attachPeerEvents (conn) {
    conn.on('message', (msg) => {
      this.emit('peer:message', { pubkeyHex: conn.pubkeyHex, message: msg })
    })

    conn.on('close', () => {
      // Only remove from map if the connection won't auto-reconnect.
      // Keeping reconnecting peers in the map prevents gossip from
      // creating duplicate PeerConnections for the same pubkey.
      if (!conn._shouldReconnect || conn._destroyed) {
        // Only delete if the map still holds THIS connection (not a replacement)
        if (this.peers.get(conn.pubkeyHex) === conn) {
          this.peers.delete(conn.pubkeyHex)
        }
      }
      this.emit('peer:disconnect', { pubkeyHex: conn.pubkeyHex, endpoint: conn.endpoint })
    })

    conn.on('error', (err) => {
      this.emit('peer:error', { pubkeyHex: conn.pubkeyHex, error: err })
    })
  }
}
