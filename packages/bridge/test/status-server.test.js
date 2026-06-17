import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PrivateKey } from '@bsv/sdk'
import { signHash } from '@relay-federation/common/crypto'
import { StatusServer } from '../lib/status-server.js'

function createMockPeerManager () {
  const pm = new EventEmitter()
  pm.peers = new Map()
  pm.connectedCount = () => {
    let count = 0
    for (const conn of pm.peers.values()) {
      if (conn.connected) count++
    }
    return count
  }
  return pm
}

function createMockHeaderRelay () {
  return {
    bestHeight: -1,
    bestHash: null,
    headers: new Map()
  }
}

function createMockTxRelay () {
  return {
    mempool: new Map(),
    knownTxids: new Set(),
    seen: new Set()
  }
}

const TEST_CONFIG = {
  pubkeyHex: 'aa'.repeat(33),
  endpoint: 'wss://test-bridge.example.com:8333',
  meshId: '70016'
}

// Use a different port for each test to avoid EADDRINUSE
let portCounter = 19333

describe('StatusServer', () => {
  let server

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('getStatus returns bridge identity', async () => {
    server = new StatusServer({ config: TEST_CONFIG })
    const status = await server.getStatus()

    assert.equal(status.bridge.pubkeyHex, TEST_CONFIG.pubkeyHex)
    assert.equal(status.bridge.endpoint, TEST_CONFIG.endpoint) // endpoint is public (advertised to peers, shown on the dashboard)
    assert.equal(status.bridge.meshId, TEST_CONFIG.meshId)
    assert.equal(typeof status.bridge.uptimeSeconds, 'number')
    assert.ok(status.bridge.uptimeSeconds >= 0)
  })

  it('getStatus returns peer info', async () => {
    const pm = createMockPeerManager()
    pm.peers.set('bb'.repeat(33), {
      pubkeyHex: 'bb'.repeat(33),
      endpoint: 'wss://peer1.example.com:8333',
      connected: true
    })
    pm.peers.set('cc'.repeat(33), {
      pubkeyHex: 'cc'.repeat(33),
      endpoint: 'wss://peer2.example.com:8333',
      connected: false
    })

    server = new StatusServer({ peerManager: pm, config: TEST_CONFIG })
    const status = await server.getStatus()

    assert.equal(status.peers.connected, 1) // only one with connected=true
    assert.equal(status.peers.list.length, 2)
    assert.equal(status.peers.list[0].pubkeyHex, 'bb'.repeat(33))
    assert.equal(status.peers.list[0].connected, true)
    assert.equal(status.peers.list[1].connected, false)
  })

  it('getStatus returns header info', async () => {
    const hr = createMockHeaderRelay()
    hr.bestHeight = 100
    hr.bestHash = 'dd'.repeat(32)
    hr.headers.set(99, { height: 99, hash: 'cc'.repeat(32), prevHash: 'bb'.repeat(32) })
    hr.headers.set(100, { height: 100, hash: 'dd'.repeat(32), prevHash: 'cc'.repeat(32) })

    server = new StatusServer({ headerRelay: hr, config: TEST_CONFIG })
    const status = await server.getStatus()

    assert.equal(status.headers.bestHeight, 100)
    assert.equal(status.headers.bestHash, 'dd'.repeat(32))
    assert.equal(status.headers.count, 2)
  })

  it('getStatus returns tx info', async () => {
    const tr = createMockTxRelay()
    tr.mempool.set('tx1', 'aabb')
    tr.mempool.set('tx2', 'ccdd')
    tr.seen.add('tx1')
    tr.seen.add('tx2')
    tr.seen.add('tx3') // seen but not in mempool (evicted)

    server = new StatusServer({ txRelay: tr, config: TEST_CONFIG })
    const status = await server.getStatus()

    assert.equal(status.txs.mempool, 2)
    assert.equal(status.txs.seen, 3)
  })

  it('getStatus works with no components (null safety)', async () => {
    server = new StatusServer({})
    const status = await server.getStatus()

    assert.equal(status.bridge.pubkeyHex, null)
    assert.equal(status.bridge.endpoint, null) // no endpoint configured
    assert.equal(status.peers.connected, 0)
    assert.equal(status.peers.list.length, 0)
    assert.equal(status.headers.bestHeight, -1)
    assert.equal(status.headers.bestHash, null)
    assert.equal(status.headers.count, 0)
    assert.equal(status.txs.mempool, 0)
    assert.equal(status.txs.seen, 0)
  })

  it('uptime increases over time', async () => {
    server = new StatusServer({ config: TEST_CONFIG })

    const s1 = await server.getStatus()
    await new Promise(resolve => setTimeout(resolve, 10))
    const s2 = await server.getStatus()

    assert.ok(s2.bridge.uptimeSeconds >= s1.bridge.uptimeSeconds)
  })

  it('HTTP server serves GET /status', async () => {
    const port = portCounter++
    const pm = createMockPeerManager()
    pm.peers.set('bb'.repeat(33), {
      pubkeyHex: 'bb'.repeat(33),
      endpoint: 'wss://peer1.example.com:8333',
      connected: true
    })

    server = new StatusServer({
      port,
      peerManager: pm,
      headerRelay: createMockHeaderRelay(),
      txRelay: createMockTxRelay(),
      config: TEST_CONFIG
    })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/status`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/json')

    const status = await res.json()
    assert.equal(status.bridge.pubkeyHex, TEST_CONFIG.pubkeyHex)
    assert.equal(status.peers.connected, 1)
    assert.equal(status.peers.list.length, 1)
  })

  it('HTTP server returns 404 for unknown paths', async () => {
    const port = portCounter++
    server = new StatusServer({ port, config: TEST_CONFIG })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/unknown`)
    assert.equal(res.status, 404)
  })

  it('HTTP server returns 404 for POST /status', async () => {
    const port = portCounter++
    server = new StatusServer({ port, config: TEST_CONFIG })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/status`, { method: 'POST' })
    assert.equal(res.status, 404)
  })

  it('stop is idempotent', async () => {
    server = new StatusServer({ config: TEST_CONFIG })
    await server.stop() // no-op, never started
    await server.stop() // still no-op
  })

  it('port getter returns configured port', () => {
    server = new StatusServer({ port: 7777, config: TEST_CONFIG })
    assert.equal(server.port, 7777)
  })

  it('default port is 9333', () => {
    server = new StatusServer({ config: TEST_CONFIG })
    assert.equal(server.port, 9333)
  })

  it('reflects live peer changes', async () => {
    const pm = createMockPeerManager()
    server = new StatusServer({ peerManager: pm, config: TEST_CONFIG })

    assert.equal((await server.getStatus()).peers.connected, 0)

    pm.peers.set('bb'.repeat(33), {
      pubkeyHex: 'bb'.repeat(33),
      endpoint: 'wss://new-peer.com:8333',
      connected: true
    })

    assert.equal((await server.getStatus()).peers.connected, 1)
    assert.equal((await server.getStatus()).peers.list.length, 1)
  })

  it('reflects live header changes', async () => {
    const hr = createMockHeaderRelay()
    server = new StatusServer({ headerRelay: hr, config: TEST_CONFIG })

    assert.equal((await server.getStatus()).headers.bestHeight, -1)

    hr.bestHeight = 500
    hr.bestHash = 'ee'.repeat(32)
    hr.headers.set(500, { height: 500, hash: 'ee'.repeat(32), prevHash: 'dd'.repeat(32) })

    assert.equal((await server.getStatus()).headers.bestHeight, 500)
    assert.equal((await server.getStatus()).headers.count, 1)
  })
})

// --- Data relay HTTP endpoints ---

function buildSignedEnvelope (opts = {}) {
  const priv = opts.privKey || PrivateKey.fromRandom()
  const pub = priv.toPublicKey().toString()
  const topic = opts.topic || 'oracle:rates:bsv'
  const payload = opts.payload || '{"USD":42.50}'
  const timestamp = opts.timestamp || Math.floor(Date.now() / 1000)
  const ttl = opts.ttl || 300
  const preimage = `${topic}${payload}${timestamp}${ttl}`
  const dataHex = Buffer.from(preimage, 'utf8').toString('hex')
  const signature = signHash(dataHex, priv)
  return { topic, payload, pubkeyHex: pub, timestamp, ttl, signature }
}

function createMockDataRelay () {
  const buffers = new Map()
  return {
    injectEnvelope (env) {
      if (!env.topic || !env.signature) return { accepted: false, error: 'missing_fields' }
      let buf = buffers.get(env.topic)
      if (!buf) { buf = []; buffers.set(env.topic, buf) }
      buf.push(env)
      return { accepted: true }
    },
    getEnvelopes (topic) { return buffers.get(topic) || [] },
    queryEnvelopes (topic, opts = {}) {
      const since = opts.since || 0
      const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
      const all = buffers.get(topic) || []
      const filtered = since > 0 ? all.filter(e => e.timestamp > since) : all
      return { envelopes: filtered.slice(0, limit), hasMore: filtered.length > limit }
    },
    getTopics () { return [...buffers.keys()] },
    getTopicSummaries () {
      const summaries = []
      for (const [topic, buf] of buffers) {
        if (buf.length > 0) {
          summaries.push({
            topic,
            count: buf.length,
            latestTimestamp: Math.max(...buf.map(e => e.timestamp))
          })
        }
      }
      return summaries
    },
    _buffers: buffers
  }
}

describe('StatusServer data endpoints', () => {
  let server
  let portCounter = 29333

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('POST /data accepts valid envelope', async () => {
    const port = portCounter++
    const dr = createMockDataRelay()
    server = new StatusServer({ port, dataRelay: dr, config: TEST_CONFIG })
    await server.start()

    const env = buildSignedEnvelope()
    const res = await fetch(`http://127.0.0.1:${port}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(env)
    })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.accepted, true)
    assert.equal(body.topic, 'oracle:rates:bsv')
  })

  it('POST /data returns 400 for missing fields', async () => {
    const port = portCounter++
    const dr = createMockDataRelay()
    server = new StatusServer({ port, dataRelay: dr, config: TEST_CONFIG })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'test' })
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'missing_fields')
  })

  it('GET /data/:topic returns cached envelopes with hasMore', async () => {
    const port = portCounter++
    const dr = createMockDataRelay()
    server = new StatusServer({ port, dataRelay: dr, config: TEST_CONFIG })
    await server.start()

    const env = buildSignedEnvelope()
    dr.injectEnvelope({ ...env, type: 'data' })

    const res = await fetch(`http://127.0.0.1:${port}/data/oracle:rates:bsv`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.topic, 'oracle:rates:bsv')
    assert.equal(body.count, 1)
    assert.equal(body.envelopes.length, 1)
    assert.equal(body.hasMore, false)
  })

  it('GET /data/:topic respects since and limit query params', async () => {
    const port = portCounter++
    const dr = createMockDataRelay()
    server = new StatusServer({ port, dataRelay: dr, config: TEST_CONFIG })
    await server.start()

    const now = Math.floor(Date.now() / 1000)
    dr.injectEnvelope({ ...buildSignedEnvelope({ timestamp: now - 60 }), type: 'data' })
    dr.injectEnvelope({ ...buildSignedEnvelope({ payload: '{"USD":43}', timestamp: now }), type: 'data' })

    // since filters to only the newer one
    const res = await fetch(`http://127.0.0.1:${port}/data/oracle:rates:bsv?since=${now - 30}&limit=10`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.count, 1)
    assert.equal(body.hasMore, false)
  })

  it('GET /data/:topic clamps limit=0 and limit=-1 at HTTP layer', async () => {
    const port = portCounter++
    const dr = createMockDataRelay()
    server = new StatusServer({ port, dataRelay: dr, config: TEST_CONFIG })
    await server.start()

    const now = Math.floor(Date.now() / 1000)
    dr.injectEnvelope({ ...buildSignedEnvelope({ payload: '{"a":1}', timestamp: now - 1 }), type: 'data' })
    dr.injectEnvelope({ ...buildSignedEnvelope({ payload: '{"a":2}', timestamp: now }), type: 'data' })

    // limit=0 should clamp to 1, not default to 10
    const res0 = await fetch(`http://127.0.0.1:${port}/data/oracle:rates:bsv?limit=0`)
    const body0 = await res0.json()
    assert.equal(body0.count, 1, 'limit=0 should clamp to 1')
    assert.equal(body0.hasMore, true)

    // limit=-1 should also clamp to 1
    const resNeg = await fetch(`http://127.0.0.1:${port}/data/oracle:rates:bsv?limit=-1`)
    const bodyNeg = await resNeg.json()
    assert.equal(bodyNeg.count, 1, 'limit=-1 should clamp to 1')
    assert.equal(bodyNeg.hasMore, true)
  })

  it('GET /data/:topic returns 404 for uncached topic', async () => {
    const port = portCounter++
    const dr = createMockDataRelay()
    server = new StatusServer({ port, dataRelay: dr, config: TEST_CONFIG })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/data/nonexistent:topic`)
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.equal(body.count, 0)
    assert.equal(body.hasMore, false)
  })

  it('GET /data/topics returns topic summary objects', async () => {
    const port = portCounter++
    const dr = createMockDataRelay()
    server = new StatusServer({ port, dataRelay: dr, config: TEST_CONFIG })
    await server.start()

    const now = Math.floor(Date.now() / 1000)
    dr.injectEnvelope({ ...buildSignedEnvelope({ topic: 'oracle:rates:bsv', timestamp: now }), type: 'data' })
    dr.injectEnvelope({ ...buildSignedEnvelope({ topic: 'attestation:test', timestamp: now - 10 }), type: 'data' })

    const res = await fetch(`http://127.0.0.1:${port}/data/topics`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.count, 2)
    // Topics should be objects with topic, count, latestTimestamp
    const oracle = body.topics.find(t => t.topic === 'oracle:rates:bsv')
    assert.ok(oracle, 'oracle topic should be present')
    assert.equal(oracle.count, 1)
    assert.equal(typeof oracle.latestTimestamp, 'number')
    const att = body.topics.find(t => t.topic === 'attestation:test')
    assert.ok(att, 'attestation topic should be present')
  })

  it('POST /data returns 503 when dataRelay not configured', async () => {
    const port = portCounter++
    server = new StatusServer({ port, config: TEST_CONFIG })
    await server.start()

    const res = await fetch(`http://127.0.0.1:${port}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: 'test' })
    })
    assert.equal(res.status, 503)
  })
})
