import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { arcRelayed } from '../lib/status-server.js'

// ARC returns HTTP 200 + a txid all through its lifecycle — including states where the tx is NOT
// yet on the network (QUEUED / RECEIVED / STORED) and states where ARC has only *announced* it
// (ANNOUNCED_TO_NETWORK = an INV sent; REQUESTED_BY_NETWORK = a node asked for it) but no node has
// actually taken it. arcRelayed must count a broadcast as relayed ONLY once a node has the tx:
// SENT_TO_NETWORK, ACCEPTED_BY_NETWORK, SEEN_ON_NETWORK, or MINED. res.ok alone is never enough —
// a STORED tx returns 200 and would otherwise be silently treated as broadcast (and lost).
const mockArc = (ok, body) => ({ ok, json: async () => body })

// ARC's documented status lifecycle, with whether each means "a node has actually taken the tx".
const STATUS_MATRIX = [
  ['QUEUED', false], // queued for processing — not on the network
  ['RECEIVED', false], // received by metamorph — not on the network
  ['STORED', false], // persisted + will retry — never relayed (the silent-loss bug)
  ['ANNOUNCED_TO_NETWORK', false], // INV announced — no node has taken it yet
  ['REQUESTED_BY_NETWORK', false], // a node asked for it — still hasn't taken it
  ['SENT_TO_NETWORK', true], // sent to >=1 node
  ['ACCEPTED_BY_NETWORK', true], // a node accepted it (ZMQ)
  ['SEEN_ON_NETWORK', true], // independently seen propagating from another node
  ['MINED', true], // in a block
  ['REJECTED', false], // explicitly rejected by the network
  ['SOME_FUTURE_STATUS', false] // unknown / future status — fail closed
]

describe('arcRelayed — relayed only once a node has actually taken the tx', () => {
  for (const [status, expected] of STATUS_MATRIX) {
    it(`${expected ? 'accepts' : 'rejects'} ${status}`, async () => {
      assert.equal(await arcRelayed(mockArc(true, { txStatus: status })), expected)
    })
  }

  it('rejects an HTTP 200 with no txStatus in the body', async () => {
    assert.equal(await arcRelayed(mockArc(true, {})), false)
  })

  it('rejects a non-ok response even if the body claims MINED', async () => {
    assert.equal(await arcRelayed(mockArc(false, { txStatus: 'MINED' })), false)
  })

  it('rejects a non-JSON / unparseable body', async () => {
    assert.equal(await arcRelayed({ ok: true, json: async () => { throw new Error('not json') } }), false)
  })

  it('rejects a null or undefined response', async () => {
    assert.equal(await arcRelayed(null), false)
    assert.equal(await arcRelayed(undefined), false)
  })
})
