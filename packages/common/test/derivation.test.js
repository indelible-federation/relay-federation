import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, PublicKey, Hash, Signature } from '@bsv/sdk'
import { deriveChild, deriveChildPub, signWithDerived, INVOICES } from '../lib/derivation.js'

describe('BRC-42 derivation', () => {
  const testKey = PrivateKey.fromRandom()
  const testPub = testKey.toPublicKey()

  describe('INVOICES', () => {
    it('has SHIP, SLAP, and HANDSHAKE constants', () => {
      assert.equal(INVOICES.SHIP, '2-SHIP-1')
      assert.equal(INVOICES.SLAP, '2-SLAP-1')
      assert.equal(INVOICES.HANDSHAKE, '2-relay-handshake-1')
    })

    it('constants are frozen', () => {
      assert.throws(() => { INVOICES.SHIP = 'changed' })
    })
  })

  describe('deriveChild', () => {
    it('derives a child key different from the identity key', () => {
      const child = deriveChild(testKey, INVOICES.SHIP)
      assert.notEqual(child.childPubHex, testPub.toString())
    })

    it('is deterministic — same key + invoice always produces same child', () => {
      const child1 = deriveChild(testKey, INVOICES.SHIP)
      const child2 = deriveChild(testKey, INVOICES.SHIP)
      assert.equal(child1.childPubHex, child2.childPubHex)
    })

    it('different invoices produce different children', () => {
      const ship = deriveChild(testKey, INVOICES.SHIP)
      const slap = deriveChild(testKey, INVOICES.SLAP)
      const handshake = deriveChild(testKey, INVOICES.HANDSHAKE)
      assert.notEqual(ship.childPubHex, slap.childPubHex)
      assert.notEqual(ship.childPubHex, handshake.childPubHex)
      assert.notEqual(slap.childPubHex, handshake.childPubHex)
    })

    it('different identity keys produce different children for same invoice', () => {
      const otherKey = PrivateKey.fromRandom()
      const child1 = deriveChild(testKey, INVOICES.SHIP)
      const child2 = deriveChild(otherKey, INVOICES.SHIP)
      assert.notEqual(child1.childPubHex, child2.childPubHex)
    })

    it('child key can sign and verify', () => {
      const { childKey, childPub } = deriveChild(testKey, INVOICES.SHIP)
      const data = Buffer.from('test data', 'utf8').toString('hex')
      const hash = Hash.sha256(Buffer.from(data, 'hex'))
      const sig = childKey.sign(hash)
      assert.ok(childPub.verify(hash, sig))
    })
  })

  describe('deriveChildPub', () => {
    it('public derivation matches private derivation', () => {
      const fromPriv = deriveChild(testKey, INVOICES.SHIP)
      const fromPub = deriveChildPub(testPub, INVOICES.SHIP)
      assert.equal(fromPriv.childPubHex, fromPub.toString())
    })

    it('works for all invoice types', () => {
      for (const invoice of Object.values(INVOICES)) {
        const fromPriv = deriveChild(testKey, invoice)
        const fromPub = deriveChildPub(testPub, invoice)
        assert.equal(fromPriv.childPubHex, fromPub.toString(), `Mismatch for invoice ${invoice}`)
      }
    })
  })

  describe('signWithDerived', () => {
    it('produces a verifiable signature from the derived key', () => {
      const data = Buffer.from('payload to sign', 'utf8').toString('hex')
      const result = signWithDerived(data, testKey, INVOICES.SHIP)

      // Verify with the derived public key
      const expectedPub = deriveChildPub(testPub, INVOICES.SHIP)
      const hash = Hash.sha256(Buffer.from(data, 'hex'))
      const sig = Signature.fromDER(result.signature, 'hex')
      assert.ok(expectedPub.verify(hash, sig))
      assert.equal(result.childPubHex, expectedPub.toString())
    })

    it('signature does NOT verify against the identity key', () => {
      const data = Buffer.from('should not verify with master', 'utf8').toString('hex')
      const result = signWithDerived(data, testKey, INVOICES.SHIP)

      const hash = Hash.sha256(Buffer.from(data, 'hex'))
      const sig = Signature.fromDER(result.signature, 'hex')
      // Must NOT verify against the master identity pubkey
      assert.equal(testPub.verify(hash, sig), false)
    })
  })

  describe('fixed derivation fixture', () => {
    // Fixed test vector: known WIF → known child pubkeys
    // If ANYONE constants or invoice wiring change, this test breaks
    const FIXTURE_WIF = 'KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU74sHUHy8S'
    const FIXTURE_IDENTITY_PUB = '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
    const FIXTURE_SHIP_CHILD = '02d1ab523f5572d711b583e15093a03d9cf873099ccaed040854f3cc3032677240'
    const FIXTURE_SLAP_CHILD = '023a0f647e26ba4e23ec9ee0e1b9e22b4d5fcb51b65ce492fbd0f47ba96b942cef'

    const fixtureKey = PrivateKey.fromWif(FIXTURE_WIF)
    const fixturePub = fixtureKey.toPublicKey()

    it('identity pubkey matches expected', () => {
      assert.equal(fixturePub.toString(), FIXTURE_IDENTITY_PUB)
    })

    it('SHIP child from private derivation matches frozen expected', () => {
      const child = deriveChild(fixtureKey, INVOICES.SHIP)
      assert.equal(child.childPubHex, FIXTURE_SHIP_CHILD)
    })

    it('SLAP child from private derivation matches frozen expected', () => {
      const child = deriveChild(fixtureKey, INVOICES.SLAP)
      assert.equal(child.childPubHex, FIXTURE_SLAP_CHILD)
    })

    it('SHIP child from public derivation matches frozen expected', () => {
      const childPub = deriveChildPub(fixturePub, INVOICES.SHIP)
      assert.equal(childPub.toString(), FIXTURE_SHIP_CHILD)
    })

    it('SLAP child from public derivation matches frozen expected', () => {
      const childPub = deriveChildPub(fixturePub, INVOICES.SLAP)
      assert.equal(childPub.toString(), FIXTURE_SLAP_CHILD)
    })
  })

  describe('cross-key reproducibility', () => {
    it('a WIF round-tripped through fromWif produces the same derived keys', () => {
      const wif = testKey.toWif()
      const restored = PrivateKey.fromWif(wif)
      const child1 = deriveChild(testKey, INVOICES.SHIP)
      const child2 = deriveChild(restored, INVOICES.SHIP)
      assert.equal(child1.childPubHex, child2.childPubHex)
    })

    it('a verifier with only the identity pubkey can verify derived signatures', () => {
      // This simulates a remote peer that knows the identity pubkey
      // but not the private key — can they verify?
      const data = Buffer.from('remote verification test', 'utf8').toString('hex')
      const result = signWithDerived(data, testKey, INVOICES.SLAP)

      // Remote peer derives the expected child pub from the identity pub
      const remotePub = deriveChildPub(testPub, INVOICES.SLAP)
      const hash = Hash.sha256(Buffer.from(data, 'hex'))
      const sig = Signature.fromDER(result.signature, 'hex')
      assert.ok(remotePub.verify(hash, sig))
    })
  })
})
