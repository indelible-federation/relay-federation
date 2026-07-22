import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Topic names — matches Go reference client (go-teranode-p2p-client/topics.go)
// Built inline so the bridge works without our upstream PRs being merged.
// ---------------------------------------------------------------------------

const PROTOCOL_PREFIX = 'teranode/bitcoin/1.0.0'

const NETWORK_LABELS = {
  main: 'mainnet', mainnet: 'mainnet',
  test: 'testnet', testnet: 'testnet',
  stn: 'stn', teratestnet: 'teratestnet'
}

function topicName (network, topic) {
  const label = NETWORK_LABELS[network] || network
  return `${PROTOCOL_PREFIX}/${label}-${topic}`
}

// ---------------------------------------------------------------------------
// Circuit-breaker defaults — a wrapper-side guard around a real robustness bug in
// the @bsv/teranode-listener package.
//
// The package's startPeerHealthMonitor (dist/index.js:261) restarts the ENTIRE
// libp2p node — full stop()+start(), new keypair, re-bootstrap, full DHT server
// — every ~60s FOREVER with no backoff, no cap, no jitter whenever peers sit at
// 0 (restart(), dist/index.js:147). On an unreachable feed that churn pegs CPU
// and, on a resource-tight host, can wedge the process.
//
// We can't durably patch the package's node_modules and it exposes no knob, so we
// guard from our wrapper: let the package self-heal SHORT blips (its fast restart
// is fine there), but once it has restarted CB_TRIP_RECONNECTS times while STILL
// at 0 peers, take over — stop() the listener to halt the churn, back off
// exponentially, and probe once per backoff window instead of hammering every 60s.
// ---------------------------------------------------------------------------
const CB_TRIP_RECONNECTS = 3          // package restarts w/ still-0 peers before we intervene (~3 min of dead feed)
const CB_BACKOFF_BASE_MS = 5 * 60_000 // first cool-off after tripping: 5 min
const CB_BACKOFF_MAX_MS = 60 * 60_000 // backoff ceiling: 60 min
const CB_POLL_MS = 15_000             // our watchdog cadence (also the peer-count poll)

// ---------------------------------------------------------------------------
// Two-layer message decoder
// ---------------------------------------------------------------------------
// Teranode gossip messages use a two-layer JSON format:
//   Layer 1 (envelope): { "name": "<sender>", "data": "<base64 inner JSON>" }
//   Layer 2 (payload):  topic-specific JSON (block, subtree, rejected-tx, node_status)
//
// Libp2p also sends 89-byte protobuf discovery probes on every topic —
// these are not application messages and should be silently dropped.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder()

function decodeGossipMessage (data) {
  if (!(data instanceof Uint8Array)) return data
  const text = decoder.decode(data)
  const envelope = JSON.parse(text) // throws on discovery probes (binary, not JSON)
  if (!envelope.data || !envelope.name) return envelope

  // Decode base64 inner payload
  const innerBytes = Buffer.from(envelope.data, 'base64')
  const payload = JSON.parse(innerBytes.toString())

  return { sender: envelope.name, payload }
}

function tryDecodeGossipMessage (data) {
  try { return decodeGossipMessage(data) } catch { return null }
}

/**
 * TeranodeClient — subscribes to Teranode's libp2p gossip network.
 *
 * Pipe #4: receives block announcements + tx batches directly from miners
 * via the @bsv/teranode-listener package (libp2p + GossipSub).
 *
 * Emits the same event interface as BSVNodeClient so the bridge can
 * wire both identically:
 *   'block'        — { sender, payload } (payload: Height, Hash, Header, Coinbase)
 *   'bestblock'    — { height, hash }
 *   'subtree'      — { sender, payload } (payload: Hash, ClientName)
 *   'rejected_tx'  — { sender, payload } (payload: TxID, Reason)
 *   'connected'    — { peerCount }
 *   'disconnected' — { peerCount }
 *   'status'       — { sender, payload } (payload: best_height, miner_name, fsm_state)
 */
export class TeranodeClient extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._listener = null
    this._peerCount = 0
    this._blockCount = 0
    this._subtreeCount = 0
    this._rejectedCount = 0
    this._statusCount = 0
    this._connected = false
    this._startTime = null
    this._lastBlock = null
    this._lastStatus = null
    this._network = opts.network || 'main'
    this._enabled = opts.enabled !== false // enabled by default

    // Injection seams (production defaults; overridden by tests):
    //   _now             — clock, so the breaker's backoff timing is testable
    //   _listenerFactory — builds a listener from a topic-callback map, so a
    //                      unit test can drive the state machine with a mock
    //                      instead of a live libp2p node.
    //   _autoWatch       — start the real poll timer in connect() (false lets a
    //                      test step _watchdogTick() deterministically).
    this._now = opts.now || (() => Date.now())
    this._listenerFactory = opts.listenerFactory || null
    this._autoWatch = opts.autoWatch !== false

    const cb = opts.circuitBreaker || {}
    this._cb = {
      tripReconnects: cb.tripReconnects ?? CB_TRIP_RECONNECTS,
      backoffBaseMs: cb.backoffBaseMs ?? CB_BACKOFF_BASE_MS,
      backoffMaxMs: cb.backoffMaxMs ?? CB_BACKOFF_MAX_MS,
      pollMs: cb.pollMs ?? CB_POLL_MS,
      open: false,               // true = we've halted the package's churn and are backing off
      backoffMs: 0,              // the wait currently in effect (0 = closed/healthy)
      nextRetryAt: 0,            // when to probe the feed again while open
      baselineReconnects: 0,     // package reconnectCount at the last known-good / rebuild point
      consecutiveTrips: 0,       // drives exponential backoff; reset to 0 on recovery
      trips: 0,                  // lifetime trips (observability)
      busy: false                // reentrancy guard for the async watchdog tick
    }
    this._peerTimer = null
  }

  /**
   * Connect to Teranode gossip network.
   * Dynamic import so the bridge still starts if @bsv/teranode-listener isn't installed.
   */
  async connect () {
    if (!this._enabled) {
      console.log('Teranode P2P: disabled in config')
      return
    }

    try {
      this._startTime = this._now()
      await this._rebuildListener() // builds the listener (auto-starts inside the package)
    } catch (err) {
      console.log(`Teranode P2P: failed to start — ${err.message}`)
      this._enabled = false
      return
    }

    // Watchdog: polls peer count AND drives the circuit-breaker (single timer,
    // survives listener rebuilds because it lives on us, not on the listener).
    if (this._autoWatch) {
      this._peerTimer = setInterval(() => { this._watchdogTick() }, this._cb.pollMs)
    }

    console.log('Teranode P2P: connecting to miner gossip network...')
  }

  /**
   * Build the topic-callback map for a fresh listener. Arrow callbacks capture
   * `this`, so every rebuilt listener feeds the same counters/events.
   */
  _topicCallbacks () {
    const net = this._network
    return {
      [topicName(net, 'block')]: (data, topic, from) => {
        const msg = tryDecodeGossipMessage(data)
        if (!msg) return // discovery probe, skip
        this._connected = true
        this._blockCount++
        this._lastBlock = msg
        this.emit('block', { data: msg, from })
        const height = msg.payload?.Height || ''
        const sender = msg.sender || from.slice(0, 16)
        console.log(`Teranode: block ${height} from ${sender}`)
      },

      [topicName(net, 'subtree')]: (data, topic, from) => {
        const msg = tryDecodeGossipMessage(data)
        if (!msg) return
        this._connected = true
        this._subtreeCount++
        this.emit('subtree', { data: msg, from })
      },

      [topicName(net, 'rejected-tx')]: (data, topic, from) => {
        const msg = tryDecodeGossipMessage(data)
        if (!msg) return
        this._rejectedCount++
        this.emit('rejected_tx', { data: msg, from })
        const reason = msg.payload?.Reason || ''
        const txid = msg.payload?.TxID || ''
        if (reason) console.log(`Teranode: rejected ${txid.slice(0, 16)}... — ${reason}`)
      },

      [topicName(net, 'node_status')]: (data, topic, from) => {
        const msg = tryDecodeGossipMessage(data)
        if (!msg) return
        this._connected = true
        this._statusCount++
        this._lastStatus = msg
        this.emit('status', { data: msg, from })
        const miner = msg.payload?.miner_name || msg.sender || from.slice(0, 16)
        const height = msg.payload?.best_height || ''
        console.log(`Teranode: ${miner} height ${height}`)
      }
    }
  }

  /** Instantiate a listener (real package by default; injectable for tests). */
  async _makeListener () {
    const callbacks = this._topicCallbacks()
    if (this._listenerFactory) return this._listenerFactory(callbacks)
    // Only need TeranodeListener from the npm package — topic names and message
    // decoding are handled inline so no dependency on our PRs. It auto-starts in
    // its constructor (dist/index.js:40).
    const { TeranodeListener } = await import('@bsv/teranode-listener')
    return new TeranodeListener(callbacks)
  }

  /** Tear down the current listener (if any) and stand up a fresh one. */
  async _rebuildListener () {
    if (this._listener) {
      try { await this._listener.stop() } catch {}
    }
    this._listener = null
    this._listener = await this._makeListener()
  }

  _reconnectCount () {
    return this._listener?.getReconnectCount?.() ?? 0
  }

  /** Escalate + schedule the next probe. wait = base·2^(trips-1), capped. */
  _scheduleBackoff () {
    const cb = this._cb
    cb.consecutiveTrips++
    cb.backoffMs = Math.min(cb.backoffBaseMs * Math.pow(2, cb.consecutiveTrips - 1), cb.backoffMaxMs)
    cb.nextRetryAt = this._now() + cb.backoffMs
    return cb.backoffMs
  }

  /**
   * One watchdog cycle: poll peers, emit connect/disconnect transitions, and
   * run the circuit-breaker state machine. Exposed (not private-by-convention
   * only) so tests can step it deterministically.
   */
  async _watchdogTick () {
    const cb = this._cb
    if (cb.busy) return
    cb.busy = true
    try {
      // OPEN: listener is stopped, churn halted. Probe once the backoff elapses.
      if (cb.open) {
        if (this._now() >= cb.nextRetryAt) {
          console.log('Teranode P2P: backoff elapsed — probing feed')
          try {
            await this._rebuildListener()
            cb.open = false
            cb.backoffMs = 0
            cb.baselineReconnects = this._reconnectCount()
          } catch (err) {
            // Probe rebuild failed — stay open, escalate, reschedule.
            const wait = this._scheduleBackoff()
            console.log(`Teranode P2P: probe failed (${err.message}) — backoff ${Math.round(wait / 60000)}min`)
          }
        }
        return
      }

      if (!this._listener) return

      const count = this._listener.getConnectedPeerCount()
      const changed = count !== this._peerCount
      this._peerCount = count
      this._connected = count > 0

      if (changed) {
        if (count > 0) {
          this.emit('connected', { peerCount: count })
          console.log(`Teranode P2P: ${count} peers connected`)
        } else {
          this.emit('disconnected', { peerCount: 0 })
          console.log('Teranode P2P: no peers')
        }
      }

      // Circuit-breaker evaluation.
      const reconnects = this._reconnectCount()
      if (count > 0) {
        // Healthy — track baseline and reset escalation so the next outage
        // starts from the base backoff again.
        cb.baselineReconnects = reconnects
        cb.consecutiveTrips = 0
      } else if (reconnects - cb.baselineReconnects >= cb.tripReconnects) {
        await this._tripBreaker(reconnects)
      }
    } catch (err) {
      console.log(`Teranode P2P: watchdog error — ${err.message}`)
    } finally {
      cb.busy = false
    }
  }

  /** Trip the breaker: stop the churning listener and enter backoff. */
  async _tripBreaker (reconnects) {
    const cb = this._cb
    cb.open = true
    cb.trips++
    const wait = this._scheduleBackoff()
    console.log(`Teranode P2P: feed unreachable (${reconnects} package restarts, 0 peers) — circuit OPEN, halting churn; probing again in ${Math.round(wait / 60000)}min`)
    if (this._listener) {
      try { await this._listener.stop() } catch {}
    }
    this._peerCount = 0
    if (this._connected) {
      this._connected = false
      this.emit('disconnected', { peerCount: 0 })
    }
  }

  /** Disconnect from Teranode network */
  async disconnect () {
    if (this._peerTimer) {
      clearInterval(this._peerTimer)
      this._peerTimer = null
    }
    if (this._listener) {
      try {
        await this._listener.stop()
      } catch {}
      this._listener = null
    }
    this._cb.open = false
    this._cb.busy = false
    this._connected = false
    this._peerCount = 0
  }

  /** Status snapshot for dashboard/health endpoint */
  getStatus () {
    const cb = this._cb
    return {
      enabled: this._enabled,
      connected: this._connected,
      peers: this._peerCount,
      blocks: this._blockCount,
      subtrees: this._subtreeCount,
      rejected: this._rejectedCount,
      statusUpdates: this._statusCount,
      lastBlock: this._lastBlock,
      lastStatus: this._lastStatus,
      reconnects: this._reconnectCount(),
      // Circuit-breaker observability (surfaces on /health so a backed-off
      // feed reads as an honest degraded-but-contained state, not silence).
      circuit: cb.open ? 'open' : 'closed',
      circuitTrips: cb.trips,
      backoffSec: cb.open ? Math.round(cb.backoffMs / 1000) : 0,
      nextProbeInSec: cb.open ? Math.max(0, Math.round((cb.nextRetryAt - this._now()) / 1000)) : 0,
      uptime: this._startTime ? Math.floor((this._now() - this._startTime) / 1000) : 0
    }
  }
}
