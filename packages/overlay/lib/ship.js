import { Transaction, PublicKey, LockingScript, OP, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk'
import { deriveChild, deriveChildPub, INVOICES } from '@relay-federation/common/derivation'
import { verifyTxBroadcast } from './chain.js'

/**
 * SHIP token builder, parser, and topic manager for the relay mesh.
 *
 * Builds BRC-48 SHIP tokens, parses them from transactions, validates
 * BRC-42 derivation, and manages admission/revocation in the overlay store.
 */

// ── Builder ──

/**
 * Build a BRC-48 SHIP token locking script.
 */
export function buildShipScript ({ identityPubHex, domain, topic, lockingPub }) {
  const fields = [
    Array.from(Buffer.from('SHIP', 'utf8')),
    Array.from(Buffer.from(identityPubHex, 'utf8')),
    Array.from(Buffer.from(domain, 'utf8')),
    Array.from(Buffer.from(topic, 'utf8'))
  ]
  const lockingPubBytes = Array.from(lockingPub.encode(true))

  return new LockingScript([
    pushData(fields[0]),
    pushData(fields[1]),
    pushData(fields[2]),
    pushData(fields[3]),
    { op: OP.OP_DROP },
    { op: OP.OP_2DROP },
    { op: OP.OP_DROP },
    pushData(lockingPubBytes),
    { op: OP.OP_CHECKSIG }
  ])
}

/**
 * Build a complete SHIP token transaction.
 */
export async function buildShipTx ({ identityKey, domain, topic, utxos }) {
  const identityPub = identityKey.toPublicKey()
  const identityPubHex = identityPub.toString()
  const { childPub } = deriveChild(identityKey, INVOICES.SHIP)
  const shipScript = buildShipScript({ identityPubHex, domain, topic, lockingPub: childPub })

  const tx = new Transaction()
  const p2pkh = new P2PKH()
  const changeLock = p2pkh.lock(identityPub.toAddress())

  for (const utxo of utxos) {
    const sourceTransaction = Transaction.fromHex(utxo.txHex)
    tx.addInput({
      sourceTransaction,
      sourceOutputIndex: utxo.outputIndex,
      unlockingScriptTemplate: p2pkh.unlock(identityKey, 'all', false, utxo.satoshis, changeLock)
    })
  }

  tx.addOutput({ lockingScript: shipScript, satoshis: 1 })
  tx.addOutput({ lockingScript: changeLock, change: true })
  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  return { txHex: tx.toHex(), txid: tx.id('hex'), shipOutputIndex: 0 }
}

// ── Parser ──

/**
 * Parse BRC-48 SHIP fields from a locking script.
 * @returns {object|null}
 */
export function parseShipFields (script) {
  try {
    const chunks = script.chunks
    if (chunks.length < 9) return null

    const fields = []
    for (let i = 0; i < 4; i++) {
      if (!chunks[i].data) return null
      fields.push(Buffer.from(chunks[i].data).toString('utf8'))
    }

    if (chunks[4].op !== 0x75) return null  // OP_DROP
    if (chunks[5].op !== 0x6d) return null  // OP_2DROP
    if (chunks[6].op !== 0x75) return null  // OP_DROP
    if (!chunks[7].data || chunks[7].data.length !== 33) return null
    if (chunks[8].op !== 0xac) return null  // OP_CHECKSIG

    return {
      protocol: fields[0],
      identityPubHex: fields[1],
      domain: fields[2],
      topic: fields[3],
      lockingPubHex: Buffer.from(chunks[7].data).toString('hex')
    }
  } catch { return null }
}

// ── Topic Manager ──

export class ShipTopicManager {
  constructor (store, { skipChainCheck = false } = {}) {
    this._store = store
    this._skipChainCheck = skipChainCheck
  }

  evaluate ({ txHex, outputIndex }) {
    let tx
    try { tx = Transaction.fromHex(txHex) } catch { return { admitted: false, reason: 'invalid_tx' } }

    const output = tx.outputs[outputIndex]
    if (!output) return { admitted: false, reason: 'output_not_found' }

    const parsed = parseShipFields(output.lockingScript)
    if (!parsed) return { admitted: false, reason: 'invalid_ship_format' }
    if (parsed.protocol !== 'SHIP') return { admitted: false, reason: 'not_ship_token' }

    let identityPub
    try { identityPub = PublicKey.fromString(parsed.identityPubHex) } catch { return { admitted: false, reason: 'invalid_identity_key' } }
    if (!parsed.domain) return { admitted: false, reason: 'empty_domain' }
    if (!parsed.topic || !parsed.topic.includes(':')) return { admitted: false, reason: 'invalid_topic' }

    const expectedPub = deriveChildPub(identityPub, INVOICES.SHIP)
    if (expectedPub.toString() !== parsed.lockingPubHex) return { admitted: false, reason: 'derivation_mismatch' }

    return {
      admitted: true,
      entry: {
        txid: tx.id('hex'),
        outputIndex,
        identityPubHex: parsed.identityPubHex,
        domain: parsed.domain,
        topic: parsed.topic,
        lockingPubHex: parsed.lockingPubHex,
        satoshis: output.satoshis ?? 1,
        outputScript: output.lockingScript?.toHex?.() || '',
        rawTx: txHex
      }
    }
  }

  async admit (entry, { skipChainCheck = false } = {}) {
    if (!skipChainCheck && !this._skipChainCheck) {
      const chainStatus = await verifyTxBroadcast(entry.txid)
      if (!chainStatus.valid) return { stored: false, reason: chainStatus.reason }
    }
    await this._store.putShipEntry(entry)
    return { stored: true }
  }

  async revoke (txid, outputIndex) {
    return this._store.deleteShipEntry(txid, outputIndex)
  }
}

function pushData (data) {
  const len = data.length
  let op = len < OP.OP_PUSHDATA1 ? len : len <= 0xff ? OP.OP_PUSHDATA1 : len <= 0xffff ? OP.OP_PUSHDATA2 : OP.OP_PUSHDATA4
  return { op, data }
}
