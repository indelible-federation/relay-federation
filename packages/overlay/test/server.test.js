import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { deriveChild, INVOICES } from '@relay-federation/common/derivation'
import { startOverlayServer } from '../lib/server.js'
import { DirectoryClient } from '../lib/client.js'
import { buildShipTx } from '../lib/ship.js'
import { createAuthSigner } from '../lib/auth.js'

describe('overlay server + client smoke', () => {
  let ctx, tmpDir, port, testKey, testPub, signer, client

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'overlay-smoke-'))
    port = 17360 + Math.floor(Math.random() * 500)
    testKey = PrivateKey.fromRandom()
    testPub = testKey.toPublicKey()
    signer = createAuthSigner(testKey)

    ctx = await startOverlayServer({
      port,
      dbPath: join(tmpDir, 'test.db'),
      identityKey: testKey,
      identityPubHex: testPub.toString(),
      skipChainCheck: true,
      pricing: { submit: 0, lookup: 0, revoke: 0 }
    })

    client = new DirectoryClient(`http://127.0.0.1:${port}`)
  })

  after(async () => {
    ctx.server.close()
    await ctx.store.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('status returns healthy', async () => {
    const s = await client.status()
    assert.equal(s.status, 'ok')
    assert.equal(s.topics, 0)
  })

  it('submit + lookup round trip', async () => {
    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: p2pkh.lock(testPub.toAddress()), satoshis: 100000 })
    const shipTx = await buildShipTx({
      identityKey: testKey,
      domain: 'smoke.test',
      topic: 'smoke:test:topic',
      utxos: [{ txHex: fundingTx.toHex(), outputIndex: 0, satoshis: 100000 }]
    })

    // Submit with auth
    const bodyStr = JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    const res = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-overlay-auth': signer.sign('POST', '/submit', bodyStr)
      },
      body: bodyStr
    })
    const submitData = await res.json()
    assert.equal(submitData.status, 'success')

    // Lookup via client
    const results = await client.findByTopic('smoke:test:topic')
    assert.equal(results.length, 1)
    assert.equal(results[0].domain, 'smoke.test')
    assert.ok(results[0].outputScript)
    assert.ok(results[0].rawTx)
  })

  it('listTopics via client', async () => {
    const topics = await client.listTopics()
    assert.ok(topics.length >= 1)
    assert.ok(topics.find(t => t.topic === 'smoke:test:topic'))
  })

  it('404 for unknown route', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent`)
    assert.equal(res.status, 404)
  })
})
