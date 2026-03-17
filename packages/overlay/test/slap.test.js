import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { deriveChild, INVOICES } from '@relay-federation/common/derivation'
import { buildSlapScript, buildSlapTx, parseSlapFields, validateSlapToken } from '../lib/slap.js'

describe('SLAP', () => {
  const testKey = PrivateKey.fromRandom()
  const testPub = testKey.toPublicKey()
  const testPubHex = testPub.toString()

  describe('buildSlapScript', () => {
    it('builds a valid BRC-48 SLAP script', () => {
      const { childPub } = deriveChild(testKey, INVOICES.SLAP)
      const script = buildSlapScript({
        identityPubHex: testPubHex,
        domain: 'example.com',
        provider: 'relay-topic-lookup',
        lockingPub: childPub
      })

      const chunks = script.chunks
      assert.ok(chunks.length >= 9)
      assert.equal(Buffer.from(chunks[0].data).toString('utf8'), 'SLAP')
      assert.equal(Buffer.from(chunks[1].data).toString('utf8'), testPubHex)
      assert.equal(Buffer.from(chunks[2].data).toString('utf8'), 'example.com')
      assert.equal(Buffer.from(chunks[3].data).toString('utf8'), 'relay-topic-lookup')
    })
  })

  describe('parseSlapFields', () => {
    it('parses fields from a built script', () => {
      const { childPub } = deriveChild(testKey, INVOICES.SLAP)
      const script = buildSlapScript({
        identityPubHex: testPubHex,
        domain: 'example.com',
        provider: 'relay-topic-lookup',
        lockingPub: childPub
      })

      const parsed = parseSlapFields(script)
      assert.ok(parsed)
      assert.equal(parsed.protocol, 'SLAP')
      assert.equal(parsed.domain, 'example.com')
      assert.equal(parsed.provider, 'relay-topic-lookup')
      assert.equal(parsed.lockingPubHex, childPub.toString())
    })
  })

  describe('validateSlapToken', () => {
    it('validates a correctly built SLAP token', async () => {
      const p2pkh = new P2PKH()
      const fundingTx = new Transaction()
      fundingTx.addOutput({ lockingScript: p2pkh.lock(testPub.toAddress()), satoshis: 100000 })

      const result = await buildSlapTx({
        identityKey: testKey,
        domain: 'example.com',
        provider: 'relay-topic-lookup',
        utxos: [{ txHex: fundingTx.toHex(), outputIndex: 0, satoshis: 100000 }]
      })

      const validation = validateSlapToken(result.txHex, result.slapOutputIndex)
      assert.equal(validation.valid, true)
      assert.equal(validation.entry.provider, 'relay-topic-lookup')
      assert.equal(validation.entry.domain, 'example.com')
    })

    it('rejects a SLAP token with wrong derivation', () => {
      const wrongKey = PrivateKey.fromRandom()
      const wrongPub = wrongKey.toPublicKey()
      const script = buildSlapScript({
        identityPubHex: testPubHex,
        domain: 'example.com',
        provider: 'relay-topic-lookup',
        lockingPub: wrongPub
      })

      const tx = new Transaction()
      tx.addOutput({ lockingScript: script, satoshis: 1 })
      const validation = validateSlapToken(tx.toHex(), 0)
      assert.equal(validation.valid, false)
      assert.equal(validation.reason, 'derivation_mismatch')
    })
  })
})
