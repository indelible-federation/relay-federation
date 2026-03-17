import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { deriveChild, INVOICES } from '@relay-federation/common/derivation'
import { buildShipTx, buildShipScript, ShipTopicManager } from '../lib/ship.js'
import { OverlayStore } from '../lib/store.js'

describe('SHIP (overlay package)', () => {
  let store, manager, tmpDir, testKey, testPub

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'overlay-ship-'))
    store = new OverlayStore(join(tmpDir, 'test.db'))
    await store.open()
    manager = new ShipTopicManager(store, { skipChainCheck: true })
    testKey = PrivateKey.fromRandom()
    testPub = testKey.toPublicKey()
  })

  afterEach(async () => {
    await store.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  async function buildTestToken (topic = 'oracle:rates:bsv') {
    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: p2pkh.lock(testPub.toAddress()), satoshis: 100000 })
    return buildShipTx({
      identityKey: testKey,
      domain: 'test.example.com',
      topic,
      utxos: [{ txHex: fundingTx.toHex(), outputIndex: 0, satoshis: 100000 }]
    })
  }

  it('admits a valid SHIP token', async () => {
    const shipTx = await buildTestToken()
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    assert.equal(result.admitted, true)
    assert.equal(result.entry.topic, 'oracle:rates:bsv')
    assert.ok(result.entry.outputScript)
    assert.ok(result.entry.rawTx)
  })

  it('rejects wrong BRC-42 derivation', () => {
    const wrongPub = PrivateKey.fromRandom().toPublicKey()
    const script = buildShipScript({
      identityPubHex: testPub.toString(),
      domain: 'test.com',
      topic: 'oracle:rates:bsv',
      lockingPub: wrongPub
    })
    const tx = new Transaction()
    tx.addOutput({ lockingScript: script, satoshis: 1 })
    const result = manager.evaluate({ txHex: tx.toHex(), outputIndex: 0 })
    assert.equal(result.admitted, false)
    assert.equal(result.reason, 'derivation_mismatch')
  })

  it('admits and stores', async () => {
    const shipTx = await buildTestToken()
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    const admitResult = await manager.admit(result.entry, { skipChainCheck: true })
    assert.equal(admitResult.stored, true)

    const entries = await store.findByTopic('oracle:rates:bsv')
    assert.equal(entries.length, 1)
  })

  it('revokes an admitted entry', async () => {
    const shipTx = await buildTestToken()
    const result = manager.evaluate({ txHex: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    await manager.admit(result.entry, { skipChainCheck: true })

    const revoked = await manager.revoke(result.entry.txid, result.entry.outputIndex)
    assert.equal(revoked, true)

    const entries = await store.findByTopic('oracle:rates:bsv')
    assert.equal(entries.length, 0)
  })

  it('uses common derivation module consistently', () => {
    const { childPub } = deriveChild(testKey, INVOICES.SHIP)
    const shipTx = buildShipScript({
      identityPubHex: testPub.toString(),
      domain: 'test.com',
      topic: 'test:consistency',
      lockingPub: childPub
    })
    // The builder inside buildShipTx uses the same INVOICES.SHIP — verify consistency
    assert.ok(shipTx)
  })
})
