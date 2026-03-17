import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey } from '@bsv/sdk'
import { deriveChild, deriveChildPub, INVOICES } from '@relay-federation/common/derivation'
import { buildShipScript } from '../lib/ship.js'

describe('overlay derivation integration', () => {
  const testKey = PrivateKey.fromRandom()

  it('builds a valid SHIP script using common derivation', () => {
    const { childPub } = deriveChild(testKey, INVOICES.SHIP)
    const script = buildShipScript({
      identityPubHex: testKey.toPublicKey().toString(),
      domain: 'example.com',
      topic: 'oracle:rates:bsv',
      lockingPub: childPub
    })
    const chunks = script.chunks
    assert.ok(chunks.length >= 9)
    assert.equal(Buffer.from(chunks[0].data).toString('utf8'), 'SHIP')
  })

  it('SHIP derivation matches between overlay and common packages', () => {
    const child1 = deriveChild(testKey, INVOICES.SHIP)
    const child2 = deriveChild(testKey, INVOICES.SHIP)
    assert.equal(child1.childPubHex, child2.childPubHex)
  })
})
