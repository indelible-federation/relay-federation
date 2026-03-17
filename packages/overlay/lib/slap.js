import { Transaction, PublicKey, LockingScript, OP, P2PKH, SatoshisPerKilobyte } from '@bsv/sdk'
import { deriveChild, deriveChildPub, INVOICES } from '@relay-federation/common/derivation'

/**
 * SLAP token builder, parser, and validator.
 * Advertises that an overlay node offers a specific lookup service.
 */

export function buildSlapScript ({ identityPubHex, domain, provider, lockingPub }) {
  const fields = [
    Array.from(Buffer.from('SLAP', 'utf8')),
    Array.from(Buffer.from(identityPubHex, 'utf8')),
    Array.from(Buffer.from(domain, 'utf8')),
    Array.from(Buffer.from(provider, 'utf8'))
  ]
  const lockingPubBytes = Array.from(lockingPub.encode(true))

  return new LockingScript([
    pushData(fields[0]), pushData(fields[1]), pushData(fields[2]), pushData(fields[3]),
    { op: OP.OP_DROP }, { op: OP.OP_2DROP }, { op: OP.OP_DROP },
    pushData(lockingPubBytes), { op: OP.OP_CHECKSIG }
  ])
}

export async function buildSlapTx ({ identityKey, domain, provider, utxos }) {
  const identityPub = identityKey.toPublicKey()
  const { childPub } = deriveChild(identityKey, INVOICES.SLAP)
  const slapScript = buildSlapScript({ identityPubHex: identityPub.toString(), domain, provider, lockingPub: childPub })

  const tx = new Transaction()
  const p2pkh = new P2PKH()
  const changeLock = p2pkh.lock(identityPub.toAddress())

  for (const utxo of utxos) {
    const sourceTransaction = Transaction.fromHex(utxo.txHex)
    tx.addInput({ sourceTransaction, sourceOutputIndex: utxo.outputIndex, unlockingScriptTemplate: p2pkh.unlock(identityKey, 'all', false, utxo.satoshis, changeLock) })
  }

  tx.addOutput({ lockingScript: slapScript, satoshis: 1 })
  tx.addOutput({ lockingScript: changeLock, change: true })
  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  return { txHex: tx.toHex(), txid: tx.id('hex'), slapOutputIndex: 0 }
}

export function parseSlapFields (script) {
  try {
    const chunks = script.chunks
    if (chunks.length < 9) return null
    const fields = []
    for (let i = 0; i < 4; i++) { if (!chunks[i].data) return null; fields.push(Buffer.from(chunks[i].data).toString('utf8')) }
    if (chunks[4].op !== 0x75 || chunks[5].op !== 0x6d || chunks[6].op !== 0x75) return null
    if (!chunks[7].data || chunks[7].data.length !== 33) return null
    if (chunks[8].op !== 0xac) return null
    return { protocol: fields[0], identityPubHex: fields[1], domain: fields[2], provider: fields[3], lockingPubHex: Buffer.from(chunks[7].data).toString('hex') }
  } catch { return null }
}

export function validateSlapToken (txHex, outputIndex) {
  let tx
  try { tx = Transaction.fromHex(txHex) } catch { return { valid: false, reason: 'invalid_tx' } }
  const output = tx.outputs[outputIndex]
  if (!output) return { valid: false, reason: 'output_not_found' }
  const parsed = parseSlapFields(output.lockingScript)
  if (!parsed) return { valid: false, reason: 'invalid_slap_format' }
  if (parsed.protocol !== 'SLAP') return { valid: false, reason: 'not_slap_token' }
  let identityPub
  try { identityPub = PublicKey.fromString(parsed.identityPubHex) } catch { return { valid: false, reason: 'invalid_identity_key' } }
  if (!parsed.domain) return { valid: false, reason: 'empty_domain' }
  if (!parsed.provider) return { valid: false, reason: 'empty_provider' }
  const expectedPub = deriveChildPub(identityPub, INVOICES.SLAP)
  if (expectedPub.toString() !== parsed.lockingPubHex) return { valid: false, reason: 'derivation_mismatch' }
  return { valid: true, entry: { txid: tx.id('hex'), outputIndex, identityPubHex: parsed.identityPubHex, domain: parsed.domain, provider: parsed.provider, lockingPubHex: parsed.lockingPubHex } }
}

function pushData (data) {
  const len = data.length
  let op = len < OP.OP_PUSHDATA1 ? len : len <= 0xff ? OP.OP_PUSHDATA1 : len <= 0xffff ? OP.OP_PUSHDATA2 : OP.OP_PUSHDATA4
  return { op, data }
}
