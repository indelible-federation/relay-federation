import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { startOverlayServer } from '@relay-federation/overlay/server'
import { DirectoryClient } from '@relay-federation/overlay/client'
import { buildShipTx } from '@relay-federation/overlay/ship'
import { createAuthSigner } from '@relay-federation/overlay/auth'

/**
 * Bridge-level tests for overlay registration and discovery.
 *
 * Tests run against a real local overlay server. BSV P2P broadcast is
 * NOT mocked — tests that call runOverlayRegister will fail at the BSV
 * node connection step. The tests verify SHIP tx construction and overlay
 * interaction up to that point.
 *
 * Same-mesh discovery tests use direct overlay submit + DirectoryClient
 * to verify the full registration → discovery → trust population flow.
 */
describe('overlay registration (bridge layer)', () => {
  let overlayCtx, tmpDir, overlayPort, testKey, testPub, testConfig, signer

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'bridge-reg-test-'))
    overlayPort = 18360 + Math.floor(Math.random() * 500)
    testKey = PrivateKey.fromRandom()
    testPub = testKey.toPublicKey()
    signer = createAuthSigner(testKey)

    testConfig = {
      wif: testKey.toWif(),
      pubkeyHex: testPub.toString(),
      endpoint: 'ws://test.example.com:8333',
      meshId: '99999',
      capabilities: ['tx_relay'],
      dataDir: join(tmpDir, 'bridge-data')
    }

    overlayCtx = await startOverlayServer({
      port: overlayPort,
      dbPath: join(tmpDir, 'overlay.db'),
      identityKey: testKey,
      identityPubHex: testPub.toString(),
      skipChainCheck: true,
      pricing: { submit: 0, lookup: 0, revoke: 0 }
    })
  })

  after(async () => {
    overlayCtx.server.close()
    await overlayCtx.store.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ── Registration ──

  it('runOverlayRegister builds SHIP tx with correct mesh topic', async () => {
    const { runOverlayRegister } = await import('../lib/actions.js')
    const { PersistentStore } = await import('../lib/persistent-store.js')

    const store = new PersistentStore(join(tmpDir, 'reg-test-db'))
    await store.open()

    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: p2pkh.lock(testPub.toAddress()), satoshis: 100000 })
    await store.putUtxo({ txid: fundingTx.id('hex'), vout: 0, satoshis: 100000, scriptHex: '', address: testConfig.pubkeyHex })
    await store.putTx(fundingTx.id('hex'), fundingTx.toHex())

    const logs = []
    try {
      await runOverlayRegister({
        config: testConfig,
        store,
        overlayUrl: `http://127.0.0.1:${overlayPort}`,
        log: (type, msg) => logs.push({ type, msg })
      })
    } catch (err) {
      if (!err.message.includes('BSV node')) throw err
    }

    assert.ok(logs.some(l => l.msg.includes('SHIP tx:')), 'Should build SHIP tx')
    assert.ok(logs.some(l => l.msg.includes('mesh:bridge:99999')), 'Should use mesh:bridge:<meshId> topic')
    assert.ok(logs.some(l => l.msg.includes('ws://test.example.com:8333')), 'Should store full endpoint')
    await store.close()
  })

  it('rejects registration when overlay is unreachable', async () => {
    const { runOverlayRegister } = await import('../lib/actions.js')
    const { PersistentStore } = await import('../lib/persistent-store.js')

    const store = new PersistentStore(join(tmpDir, 'reg-fail-db'))
    await store.open()

    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: p2pkh.lock(testPub.toAddress()), satoshis: 100000 })
    await store.putUtxo({ txid: fundingTx.id('hex'), vout: 0, satoshis: 100000, scriptHex: '', address: testConfig.pubkeyHex })
    await store.putTx(fundingTx.id('hex'), fundingTx.toHex())

    try {
      await runOverlayRegister({
        config: testConfig, store,
        overlayUrl: 'http://127.0.0.1:19999',
        log: () => {}
      })
      assert.fail('Should have thrown')
    } catch (err) {
      assert.ok(err.message.length > 0)
    }

    const shipTxid = await store.getMeta('overlay_ship_txid')
    assert.ok(!shipTxid, 'No metadata stored on failure')
    await store.close()
  })

  // ── Same-mesh discovery ──

  it('discovers peers registered to the same mesh only', async () => {
    const client = new DirectoryClient(`http://127.0.0.1:${overlayPort}`)

    // Register bridge A on mesh 70016
    const keyA = PrivateKey.fromRandom()
    const pubA = keyA.toPublicKey()
    const signerA = createAuthSigner(keyA)
    const shipA = await buildShipTx({
      identityKey: keyA,
      domain: 'ws://bridgeA.test:8333',
      topic: 'mesh:bridge:70016',
      utxos: [fakeFundedUtxo(pubA)]
    })
    await authenticatedSubmit(shipA, signerA)

    // Register bridge B on mesh 70016 (same mesh)
    const keyB = PrivateKey.fromRandom()
    const pubB = keyB.toPublicKey()
    const signerB = createAuthSigner(keyB)
    const shipB = await buildShipTx({
      identityKey: keyB,
      domain: 'ws://bridgeB.test:8333',
      topic: 'mesh:bridge:70016',
      utxos: [fakeFundedUtxo(pubB)]
    })
    await authenticatedSubmit(shipB, signerB)

    // Register bridge C on mesh 88888 (different mesh)
    const keyC = PrivateKey.fromRandom()
    const pubC = keyC.toPublicKey()
    const signerC = createAuthSigner(keyC)
    const shipC = await buildShipTx({
      identityKey: keyC,
      domain: 'ws://bridgeC.test:8333',
      topic: 'mesh:bridge:88888',
      utxos: [fakeFundedUtxo(pubC)]
    })
    await authenticatedSubmit(shipC, signerC)

    // Query for mesh 70016 — should find A and B but NOT C
    const mesh70016 = await client.findByTopic('mesh:bridge:70016')
    assert.equal(mesh70016.length, 2, 'Should find 2 bridges on mesh 70016')
    const pubkeys70016 = mesh70016.map(e => e.identityPubHex)
    assert.ok(pubkeys70016.includes(pubA.toString()), 'Should include bridge A')
    assert.ok(pubkeys70016.includes(pubB.toString()), 'Should include bridge B')
    assert.ok(!pubkeys70016.includes(pubC.toString()), 'Should NOT include bridge C')

    // Query for mesh 88888 — should find only C
    const mesh88888 = await client.findByTopic('mesh:bridge:88888')
    assert.equal(mesh88888.length, 1, 'Should find 1 bridge on mesh 88888')
    assert.equal(mesh88888[0].identityPubHex, pubC.toString())
  })

  it('overlay entries contain dialable WebSocket endpoints', async () => {
    const client = new DirectoryClient(`http://127.0.0.1:${overlayPort}`)
    const entries = await client.findByTopic('mesh:bridge:70016')
    assert.ok(entries.length >= 2)

    for (const entry of entries) {
      assert.ok(entry.domain.startsWith('ws://'), `Endpoint should be ws:// URL, got: ${entry.domain}`)
      assert.ok(entry.identityPubHex.length === 66, 'Should have compressed pubkey')
    }
  })

  it('overlay status reflects registered entries', async () => {
    const client = new DirectoryClient(`http://127.0.0.1:${overlayPort}`)
    const status = await client.status()
    assert.equal(status.status, 'ok')
    assert.ok(status.topics >= 2, 'Should have at least 2 mesh topics')
    assert.ok(status.entries >= 3, 'Should have at least 3 entries')
  })

  // ── Helpers ──

  function fakeFundedUtxo (pub) {
    const p2pkh = new P2PKH()
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript: p2pkh.lock(pub.toAddress()), satoshis: 100000 })
    return { txHex: fundingTx.toHex(), outputIndex: 0, satoshis: 100000 }
  }

  async function authenticatedSubmit (shipTx, authSigner) {
    const bodyStr = JSON.stringify({ rawTx: shipTx.txHex, outputIndex: shipTx.shipOutputIndex })
    const res = await fetch(`http://127.0.0.1:${overlayPort}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-overlay-auth': authSigner.sign('POST', '/submit', bodyStr)
      },
      body: bodyStr
    })
    const data = await res.json()
    assert.equal(data.status, 'success', `Submit should succeed: ${JSON.stringify(data)}`)
  }
})
