import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TeranodeClient } from '../lib/teranode-client.js'

// ---------------------------------------------------------------------------
// Circuit-breaker tests for TeranodeClient.
//
// These drive the breaker with a MOCK listener (no libp2p) and an injected
// clock, so trip/backoff/probe/recovery are fully deterministic — the live
// proof that the wrapper-side guard tames the @bsv/teranode-listener package's
// unbounded 60s reconnect loop that can wedge a resource-tight host.
// ---------------------------------------------------------------------------

// A fake TeranodeListener: the test mutates `peers` / `reconnectCount` between
// ticks to simulate the package's real behavior, and inspects stop() calls.
function harness () {
  const listeners = []
  const factory = () => {
    const l = {
      peers: 0,
      reconnectCount: 0,
      stopCalls: 0,
      stopped: false,
      getConnectedPeerCount () { return this.peers },
      getReconnectCount () { return this.reconnectCount },
      async stop () { this.stopped = true; this.stopCalls++ }
    }
    listeners.push(l)
    return l
  }
  return { factory, listeners, get current () { return listeners[listeners.length - 1] } }
}

function mkClient (h, now, cbOverrides = {}) {
  return new TeranodeClient({
    listenerFactory: h.factory,
    now,
    autoWatch: false, // step _watchdogTick() manually
    circuitBreaker: {
      tripReconnects: 3,
      backoffBaseMs: 5 * 60_000,
      backoffMaxMs: 60 * 60_000,
      pollMs: 15_000,
      ...cbOverrides
    }
  })
}

test('healthy feed never trips and never rebuilds', async () => {
  const h = harness(); let clock = 0; const now = () => clock
  const c = mkClient(h, now)
  await c.connect()
  h.current.peers = 8
  for (let i = 0; i < 12; i++) { clock += 15_000; await c._watchdogTick() }
  const s = c.getStatus()
  assert.equal(s.circuit, 'closed')
  assert.equal(s.circuitTrips, 0)
  assert.equal(s.peers, 8)
  assert.equal(h.listeners.length, 1, 'no rebuild on a healthy feed')
  assert.equal(h.current.stopCalls, 0, 'never stopped')
})

test('short blip under threshold: package self-heals, we do not intervene', async () => {
  const h = harness(); let clock = 0; const now = () => clock
  const c = mkClient(h, now)
  await c.connect()
  const L = h.current
  L.peers = 0
  L.reconnectCount = 1; clock += 15_000; await c._watchdogTick()
  L.reconnectCount = 2; clock += 15_000; await c._watchdogTick() // 2 < 3 → no trip
  assert.equal(c.getStatus().circuit, 'closed')
  assert.equal(c.getStatus().circuitTrips, 0)
  L.peers = 5; clock += 15_000; await c._watchdogTick() // recovers
  assert.equal(c.getStatus().circuit, 'closed')
  assert.equal(h.listeners.length, 1, 'package handled it, no wrapper-side rebuild')
  assert.equal(L.stopCalls, 0, 'we never stopped the listener')
})

test('sustained dead feed trips, halts churn, opens with base backoff', async () => {
  const h = harness(); let clock = 0; const now = () => clock
  const c = mkClient(h, now)
  await c.connect()
  const L = h.current
  L.peers = 0
  L.reconnectCount = 1; clock += 15_000; await c._watchdogTick()
  L.reconnectCount = 2; clock += 15_000; await c._watchdogTick()
  assert.equal(c.getStatus().circuit, 'closed', 'still under threshold at 2')
  L.reconnectCount = 3; clock += 15_000; await c._watchdogTick() // trips
  const s = c.getStatus()
  assert.equal(s.circuit, 'open')
  assert.equal(s.circuitTrips, 1)
  assert.equal(s.backoffSec, 300, 'base backoff = 5 min')
  assert.equal(s.nextProbeInSec, 300)
  assert.equal(L.stopCalls, 1, 'the churning listener was stopped')
})

test('while open, does not probe until backoff elapses; then rebuilds once', async () => {
  const h = harness(); let clock = 0; const now = () => clock
  const c = mkClient(h, now)
  await c.connect()
  const L = h.current
  L.peers = 0; L.reconnectCount = 3; clock += 15_000; await c._watchdogTick() // trip
  assert.equal(c.getStatus().circuit, 'open')

  // 1 minute later — still backing off, no rebuild, no churn.
  clock += 60_000; await c._watchdogTick()
  assert.equal(h.listeners.length, 1)
  assert.equal(c.getStatus().circuit, 'open')

  // 5-min backoff elapses — a single probe rebuilds a fresh listener.
  clock += 5 * 60_000; await c._watchdogTick()
  assert.equal(h.listeners.length, 2, 'exactly one rebuild on probe')
  assert.equal(c.getStatus().circuit, 'closed', 'tentatively closed to evaluate the fresh listener')
})

test('recovery after probe closes the breaker and resets escalation', async () => {
  const h = harness(); let clock = 0; const now = () => clock
  const c = mkClient(h, now)
  await c.connect()
  h.current.peers = 0; h.current.reconnectCount = 3; clock += 15_000; await c._watchdogTick() // trip
  clock += 5 * 60_000; await c._watchdogTick() // probe → rebuild (listeners[1])
  h.current.peers = 7; clock += 15_000; await c._watchdogTick() // fresh listener gets peers
  const s = c.getStatus()
  assert.equal(s.circuit, 'closed')
  assert.equal(s.peers, 7)
  assert.equal(s.backoffSec, 0)
  assert.equal(c._cb.consecutiveTrips, 0, 'escalation reset on recovery')
})

test('repeated failure escalates backoff base -> 2x', async () => {
  const h = harness(); let clock = 0; const now = () => clock
  const c = mkClient(h, now)
  await c.connect()
  h.current.peers = 0; h.current.reconnectCount = 3; clock += 15_000; await c._watchdogTick() // trip1
  assert.equal(c.getStatus().backoffSec, 300, 'trip1 = 5 min')

  clock += 5 * 60_000; await c._watchdogTick() // probe rebuild (listeners[1], dead)
  const L2 = h.current
  L2.peers = 0
  L2.reconnectCount = 1; clock += 15_000; await c._watchdogTick()
  L2.reconnectCount = 2; clock += 15_000; await c._watchdogTick()
  L2.reconnectCount = 3; clock += 15_000; await c._watchdogTick() // trip2
  const s = c.getStatus()
  assert.equal(s.circuit, 'open')
  assert.equal(s.circuitTrips, 2)
  assert.equal(s.backoffSec, 600, 'trip2 = 10 min (base x2)')
})

test('backoff is capped at max across many failures', async () => {
  const h = harness(); let clock = 0; const now = () => clock
  // tiny values so the cap is reached fast: 1s base, 4s cap, trip on first 0-peer poll
  const c = mkClient(h, now, { backoffBaseMs: 1000, backoffMaxMs: 4000, tripReconnects: 1 })
  await c.connect()
  const expectedSec = [1, 2, 4, 4, 4]
  for (let i = 0; i < expectedSec.length; i++) {
    const L = h.current
    L.peers = 0; L.reconnectCount = 1; clock += 15_000; await c._watchdogTick() // trip
    assert.equal(c.getStatus().backoffSec, expectedSec[i], `trip ${i + 1} backoff`)
    clock += expectedSec[i] * 1000; await c._watchdogTick() // elapse → probe rebuild
  }
})
