import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

/**
 * PeerConnection — wraps a WebSocket connection to a single peer.
 *
 * JSON message framing: all messages are JSON objects with a `type` field.
 * Supports both outbound (we connect to them) and inbound (they connect to us).
 *
 * Events:
 *   'message'  — { type, ...payload } parsed JSON message
 *   'open'     — connection established
 *   'close'    — connection closed
 *   'error'    — connection error
 */
export class PeerConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint - WSS endpoint of the peer
   * @param {string} opts.pubkeyHex - Peer's compressed pubkey (hex)
   * @param {WebSocket} [opts.socket] - Existing socket (for inbound connections)
   */
  constructor (opts) {
    super()
    this.endpoint = opts.endpoint
    this.pubkeyHex = opts.pubkeyHex
    this.ws = opts.socket || null
    this.connected = false
    this._reconnectTimer = null
    this._reconnectDelay = 5000
    this._maxReconnectDelay = 60000
    this._shouldReconnect = !opts.socket // only auto-reconnect outbound
    this._destroyed = false

    if (opts.socket) {
      this._attachListeners(opts.socket)
      this.connected = opts.socket.readyState === WebSocket.OPEN
    }
  }

  /** Connect to the peer (outbound only). */
  connect () {
    if (this._destroyed) return
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return

    try {
      this.ws = new WebSocket(this.endpoint, {
        perMessageDeflate: false
      })
      this._attachListeners(this.ws)
    } catch (err) {
      this.emit('error', err)
      this._scheduleReconnect()
    }
  }

  /** Send a JSON message to the peer. */
  send (msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }
    this.ws.send(JSON.stringify(msg))
    return true
  }

  /** Close the connection permanently (no reconnect). */
  destroy () {
    this._destroyed = true
    this._shouldReconnect = false
    clearTimeout(this._reconnectTimer)
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
  }

  _attachListeners (ws) {
    ws.on('open', () => {
      this.connected = true
      this._reconnectDelay = 5000 // reset backoff on success
      console.log(`[ws-out] ${this.endpoint} extensions="${ws.extensions || ''}"`)
      this.emit('open')
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg && typeof msg.type === 'string') {
          this.emit('message', msg)
        }
      } catch (err) {
        // Ignore non-JSON messages
      }
    })

    ws.on('close', () => {
      this.connected = false
      this.emit('close')
      this._scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.emit('error', err)
    })
  }

  _scheduleReconnect () {
    if (!this._shouldReconnect || this._destroyed) return
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = setTimeout(() => {
      this.connect()
    }, this._reconnectDelay)
    // Exponential backoff, capped
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay)
  }
}
