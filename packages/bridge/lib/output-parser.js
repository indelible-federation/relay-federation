import { Transaction, Hash, PublicKey, P2PKH } from '@bsv/sdk'
import { createHash } from 'node:crypto'

/**
 * OutputParser — extracts addresses and script info from raw transactions.
 *
 * Parses raw transaction hex and inspects each output to determine:
 * - Whether it's a standard P2PKH output
 * - The hash160 (pubkey hash) it pays to
 * - The satoshi value
 *
 * Also inspects inputs to determine which UTXOs are being spent.
 *
 * This module does NOT depend on any network calls — pure local parsing.
 */

/**
 * Parse a raw transaction hex into structured output info.
 * @param {string} rawHex — raw transaction hex string
 * @returns {{ txid: string, inputs: Array<{ prevTxid: string, prevVout: number }>, outputs: Array<{ vout: number, satoshis: number, scriptHex: string, hash160: string|null, isP2PKH: boolean }> }}
 */
export function parseTx (rawHex) {
  const tx = Transaction.fromHex(rawHex)
  const txid = tx.id('hex')

  const inputs = tx.inputs.map(input => ({
    prevTxid: typeof input.sourceTXID === 'string'
      ? input.sourceTXID
      : Buffer.from(input.sourceTXID).toString('hex'),
    prevVout: input.sourceOutputIndex
  }))

  const outputs = tx.outputs.map((output, vout) => {
    const scriptHex = output.lockingScript.toHex()
    const satoshis = output.satoshis
    const parsed = parseOutputScript(scriptHex)
    return {
      vout,
      satoshis,
      scriptHex,
      scriptHash: createHash('sha256').update(Buffer.from(scriptHex, 'hex')).digest('hex'),
      hash160: parsed.hash160,
      isP2PKH: parsed.isP2PKH,
      type: parsed.type,
      data: parsed.data,
      protocol: parsed.protocol,
      parsed: parsed.parsed
    }
  })

  return { txid, inputs, outputs }
}

/**
 * Parse a locking script hex to extract hash160 if it's P2PKH.
 *
 * Standard P2PKH script: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
 * Hex pattern: 76a914{40 hex chars}88ac
 *
 * @param {string} scriptHex
 * @returns {{ isP2PKH: boolean, hash160: string|null }}
 */
export function parseOutputScript (scriptHex) {
  const base = { isP2PKH: false, hash160: null, type: 'unknown', data: null, protocol: null, parsed: null }

  // 1. P2PKH: 76 a9 14 <20 bytes hash160> 88 ac (fast path — most common)
  if (scriptHex.length === 50 &&
      scriptHex.startsWith('76a914') &&
      scriptHex.endsWith('88ac')) {
    return { ...base, type: 'p2pkh', isP2PKH: true, hash160: scriptHex.slice(6, 46) }
  }

  // 2. OP_RETURN / OP_FALSE OP_RETURN
  if (scriptHex.startsWith('6a') || scriptHex.startsWith('006a')) {
    const opReturn = parseOpReturn(scriptHex)
    if (opReturn) {
      const { protocol, parsed } = detectProtocol(opReturn.pushes)
      return { ...base, type: 'op_return', data: opReturn.pushes, protocol, parsed }
    }
  }

  // 3. Ordinal inscription (OP_FALSE OP_IF OP_PUSH3 "ord" ...)
  if (scriptHex.includes(ORD_ENVELOPE)) {
    const ord = parseOrdinal(scriptHex)
    if (ord) {
      // Extract hash160 from P2PKH wrapper if present
      let hash160 = null
      if (scriptHex.startsWith('76a914') && scriptHex.length > 50) {
        hash160 = scriptHex.slice(6, 46)
      }
      return {
        ...base,
        type: 'ordinal',
        isP2PKH: !!hash160,
        hash160,
        protocol: ord.isBsv20 ? 'bsv-20' : 'ordinal',
        parsed: ord
      }
    }
  }

  // 4. P2SH: a9 14 <20 bytes> 87
  const p2sh = parseP2SH(scriptHex)
  if (p2sh) {
    return { ...base, type: 'p2sh', parsed: p2sh }
  }

  // 5. Bare multisig: OP_m <pubkeys> OP_n OP_CHECKMULTISIG
  if (scriptHex.endsWith('ae')) {
    const multi = parseMultisig(scriptHex)
    if (multi) {
      return { ...base, type: 'multisig', parsed: multi }
    }
  }

  // 6. Unknown script type
  return base
}

/**
 * Compute the hash160 of a compressed public key hex.
 * hash160 = RIPEMD160(SHA256(pubkey))
 *
 * @param {string} pubkeyHex — 33-byte compressed public key as hex
 * @returns {string} 20-byte hash160 as hex
 */
export function pubkeyToHash160 (pubkeyHex) {
  const pubkeyBytes = Buffer.from(pubkeyHex, 'hex')
  const sha = Hash.sha256(pubkeyBytes)
  const h160 = Hash.ripemd160(sha)
  return Buffer.from(h160).toString('hex')
}

/**
 * Convert a BSV address to its hash160 (pubkey hash).
 * Uses P2PKH locking script to extract the hash160.
 *
 * @param {string} address — BSV address (e.g. '1KhH4V...')
 * @returns {string} 20-byte hash160 as hex
 */
export function addressToHash160 (address) {
  const script = new P2PKH().lock(address).toHex()
  // P2PKH script: 76a914{hash160}88ac
  return script.slice(6, 46)
}

/**
 * Check if a transaction has any outputs paying to a set of watched hash160s.
 *
 * @param {string} rawHex — raw transaction hex
 * @param {Set<string>} watchedHash160s — set of hash160 hex strings to watch
 * @returns {{ txid: string, matches: Array<{ vout: number, satoshis: number, scriptHex: string, hash160: string }>, spends: Array<{ prevTxid: string, prevVout: number }> }}
 */
export function checkTxForWatched (rawHex, watchedHash160s) {
  // The relay path feeds this ARBITRARY network txs, so a parse failure is an EXPECTED
  // condition, not a fatal one. A non-standard / oversized tx (e.g. a field past JS's 53-bit
  // safe-int limit, which @bsv/sdk's BigNumber.toNumber throws on) must never take the bridge
  // down — without this guard the throw becomes an unhandled rejection and the process
  // fail-fast-exits. Such a tx simply can't be matched against watched addresses, so skip it.
  let parsed
  try {
    parsed = parseTx(rawHex)
  } catch (err) {
    console.warn(`[output-parser] skipping unparseable tx: ${err && err.message}`)
    return { txid: null, matches: [], spends: [] }
  }

  const matches = parsed.outputs
    .filter(o => o.isP2PKH && watchedHash160s.has(o.hash160))
    .map(o => ({
      vout: o.vout,
      satoshis: o.satoshis,
      scriptHex: o.scriptHex,
      hash160: o.hash160
    }))

  return {
    txid: parsed.txid,
    matches,
    spends: parsed.inputs
  }
}

// --- Protocol constants ---

const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'
const BCAT_PREFIX = '15DHFxWZJT58f9nhyGnsRBqrgwK4W6h4Up'
const BCAT_PART_PREFIX = '1ChDHzdd1H4wSjgGMHyndZm6qxEDGjqpJL'
const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'
const METANET_MAGIC = '6d657461' // "meta" as hex

// Ordinal envelope: OP_FALSE OP_IF OP_PUSH3 "ord"
const ORD_ENVELOPE = '0063036f7264'

// --- Script reading utilities ---

/**
 * Read a pushdata segment from a script hex string at the given offset.
 * Handles direct-length (1-75), OP_PUSHDATA1 (0x4c), OP_PUSHDATA2 (0x4d).
 *
 * @param {string} hex — script as hex string
 * @param {number} offset — byte offset (in hex chars, so multiply by 2)
 * @returns {{ data: string, newOffset: number }} data as hex string
 */
function readPushData (hex, offset) {
  const opByte = parseInt(hex.slice(offset, offset + 2), 16)
  offset += 2

  let dataLen
  if (opByte >= 1 && opByte <= 75) {
    dataLen = opByte
  } else if (opByte === 0x4c) { // OP_PUSHDATA1
    dataLen = parseInt(hex.slice(offset, offset + 2), 16)
    offset += 2
  } else if (opByte === 0x4d) { // OP_PUSHDATA2
    dataLen = parseInt(hex.slice(offset, offset + 2), 16) +
              parseInt(hex.slice(offset + 2, offset + 4), 16) * 256
    offset += 4
  } else if (opByte === 0x4e) { // OP_PUSHDATA4
    dataLen = parseInt(hex.slice(offset, offset + 2), 16) +
              parseInt(hex.slice(offset + 2, offset + 4), 16) * 256 +
              parseInt(hex.slice(offset + 4, offset + 6), 16) * 65536 +
              parseInt(hex.slice(offset + 6, offset + 8), 16) * 16777216
    offset += 8
  } else {
    return { data: null, opByte, newOffset: offset }
  }

  const dataHex = hex.slice(offset, offset + dataLen * 2)
  return { data: dataHex, newOffset: offset + dataLen * 2 }
}

/**
 * Extract all push data segments from an OP_RETURN script.
 * Skips the OP_RETURN (and optional OP_FALSE) prefix.
 *
 * @param {string} scriptHex
 * @returns {{ pushes: string[], isFalseReturn: boolean }}
 */
export function parseOpReturn (scriptHex) {
  let offset = 0
  let isFalseReturn = false

  if (scriptHex.startsWith('006a')) {
    offset = 4 // skip OP_FALSE OP_RETURN
    isFalseReturn = true
  } else if (scriptHex.startsWith('6a')) {
    offset = 2 // skip OP_RETURN
  } else {
    return null
  }

  const pushes = []
  while (offset < scriptHex.length) {
    const byte = parseInt(scriptHex.slice(offset, offset + 2), 16)

    // OP_0 pushes empty data
    if (byte === 0x00) {
      pushes.push('')
      offset += 2
      continue
    }
    // OP_1 through OP_16 push their number
    if (byte >= 0x51 && byte <= 0x60) {
      pushes.push((byte - 0x50).toString(16).padStart(2, '0'))
      offset += 2
      continue
    }

    const result = readPushData(scriptHex, offset)
    if (result.data === null) break // unknown opcode, stop
    pushes.push(result.data)
    offset = result.newOffset
  }

  return { pushes, isFalseReturn }
}

/**
 * Detect which protocol an OP_RETURN output uses based on its first push.
 *
 * @param {string[]} pushes — array of hex push data
 * @returns {{ protocol: string|null, parsed: object|null }}
 */
function detectProtocol (pushes) {
  if (!pushes || pushes.length === 0) return { protocol: null, parsed: null }

  const firstPush = hexToUtf8(pushes[0])

  if (firstPush === B_PREFIX) {
    return { protocol: 'b', parsed: parseBProtocol(pushes) }
  }
  if (firstPush === BCAT_PREFIX) {
    return { protocol: 'bcat', parsed: parseBCATLinker(pushes) }
  }
  if (firstPush === BCAT_PART_PREFIX) {
    return { protocol: 'bcat-part', parsed: parseBCATPart(pushes) }
  }
  if (firstPush === MAP_PREFIX) {
    return { protocol: 'map', parsed: parseMAP(pushes) }
  }
  if (pushes[0] === METANET_MAGIC) {
    return { protocol: 'metanet', parsed: parseMetaNet(pushes) }
  }

  return { protocol: null, parsed: null }
}

// --- Protocol parsers ---

/**
 * Parse B:// protocol fields.
 * Format: <B_PREFIX> <data> <mimeType> [encoding] [filename]
 */
function parseBProtocol (pushes) {
  return {
    data: pushes[1] || null,
    mimeType: pushes[2] ? hexToUtf8(pushes[2]) : null,
    encoding: pushes[3] ? hexToUtf8(pushes[3]) : null,
    filename: pushes[4] ? hexToUtf8(pushes[4]) : null
  }
}

/**
 * Parse BCAT linker fields.
 * Format: <BCAT_PREFIX> <info> <mimeType> <charset> <filename> <flag> <txid1> <txid2> ...
 */
function parseBCATLinker (pushes) {
  const chunkTxids = []
  for (let i = 6; i < pushes.length; i++) {
    if (pushes[i] && pushes[i].length === 64) {
      chunkTxids.push(pushes[i])
    }
  }
  return {
    info: pushes[1] ? hexToUtf8(pushes[1]) : null,
    mimeType: pushes[2] ? hexToUtf8(pushes[2]) : null,
    charset: pushes[3] ? hexToUtf8(pushes[3]) : null,
    filename: pushes[4] ? hexToUtf8(pushes[4]) : null,
    flag: pushes[5] ? hexToUtf8(pushes[5]) : null,
    chunkTxids
  }
}

/**
 * Parse BCAT part (chunk) fields.
 * Format: <BCAT_PART_PREFIX> <raw data>
 */
function parseBCATPart (pushes) {
  return {
    data: pushes[1] || null
  }
}

/**
 * Parse MAP protocol fields.
 * Format: <MAP_PREFIX> SET <key> <value> <key> <value> ...
 */
function parseMAP (pushes) {
  const action = pushes[1] ? hexToUtf8(pushes[1]) : null
  const pairs = {}
  for (let i = 2; i < pushes.length - 1; i += 2) {
    const key = hexToUtf8(pushes[i])
    const value = hexToUtf8(pushes[i + 1] || '')
    if (key) pairs[key] = value
  }
  return { action, pairs }
}

/**
 * Parse MetaNet protocol fields.
 * Format: <"meta" 4 bytes> <nodeAddress> <parentTxid>
 */
function parseMetaNet (pushes) {
  return {
    nodeAddress: pushes[1] ? hexToUtf8(pushes[1]) : null,
    parentTxid: pushes[2] || null
  }
}

/**
 * Parse a 1Sat Ordinal inscription from a script hex.
 * Scans for the envelope: OP_FALSE OP_IF OP_PUSH3 "ord" ... OP_ENDIF
 *
 * @param {string} scriptHex
 * @returns {{ contentType: string|null, content: string|null, isBsv20: boolean, bsv20: object|null }|null}
 */
export function parseOrdinal (scriptHex) {
  const envIdx = scriptHex.indexOf(ORD_ENVELOPE)
  if (envIdx === -1) return null

  // Start after the "ord" push: skip OP_FALSE(00) OP_IF(63) OP_PUSH3(03) "ord"(6f7264)
  let offset = envIdx + ORD_ENVELOPE.length
  let contentType = null
  let content = null

  while (offset < scriptHex.length) {
    const byte = parseInt(scriptHex.slice(offset, offset + 2), 16)
    offset += 2

    if (byte === 0x68) break // OP_ENDIF

    // Field tag
    if (byte === 0x51) {
      // OP_1 = content type field, next push is the mime type
      const result = readPushData(scriptHex, offset)
      if (result.data !== null) {
        contentType = hexToUtf8(result.data)
        offset = result.newOffset
      }
    } else if (byte === 0x00) {
      // OP_0 = content body field, next push is the data
      const result = readPushData(scriptHex, offset)
      if (result.data !== null) {
        content = result.data
        offset = result.newOffset
      }
    } else if (byte >= 0x01 && byte <= 0x4b) {
      // Direct push — skip this data (unknown field)
      offset += byte * 2
    } else if (byte === 0x4c) {
      const len = parseInt(scriptHex.slice(offset, offset + 2), 16)
      offset += 2 + len * 2
    } else if (byte === 0x4d) {
      const len = parseInt(scriptHex.slice(offset, offset + 2), 16) +
                  parseInt(scriptHex.slice(offset + 2, offset + 4), 16) * 256
      offset += 4 + len * 2
    }
  }

  let isBsv20 = false
  let bsv20 = null
  if (contentType === 'application/bsv-20' && content) {
    isBsv20 = true
    try {
      bsv20 = JSON.parse(hexToUtf8(content))
    } catch { /* invalid JSON */ }
  }

  return { contentType, content, isBsv20, bsv20 }
}

/**
 * Detect P2SH script: OP_HASH160 <20 bytes> OP_EQUAL
 * Hex pattern: a914{40 hex chars}87
 * Deprecated on BSV since Genesis (Feb 2020) but exists in history.
 *
 * @param {string} scriptHex
 * @returns {{ scriptHash: string }|null}
 */
function parseP2SH (scriptHex) {
  if (scriptHex.length === 46 &&
      scriptHex.startsWith('a914') &&
      scriptHex.endsWith('87')) {
    return { scriptHash: scriptHex.slice(4, 44) }
  }
  return null
}

/**
 * Detect bare multisig: OP_m <pubkeys> OP_n OP_CHECKMULTISIG
 *
 * @param {string} scriptHex
 * @returns {{ m: number, n: number, pubkeys: string[] }|null}
 */
function parseMultisig (scriptHex) {
  // Must end with OP_CHECKMULTISIG (ae)
  if (!scriptHex.endsWith('ae')) return null

  const firstByte = parseInt(scriptHex.slice(0, 2), 16)
  if (firstByte < 0x51 || firstByte > 0x60) return null // not OP_1..OP_16
  const m = firstByte - 0x50

  // Read public keys
  const pubkeys = []
  let offset = 2
  while (offset < scriptHex.length - 4) { // -4 for OP_n + OP_CHECKMULTISIG
    const pushLen = parseInt(scriptHex.slice(offset, offset + 2), 16)
    if (pushLen !== 0x21 && pushLen !== 0x41) break // not 33 or 65 byte key
    offset += 2
    pubkeys.push(scriptHex.slice(offset, offset + pushLen * 2))
    offset += pushLen * 2
  }

  if (pubkeys.length === 0) return null

  const nByte = parseInt(scriptHex.slice(offset, offset + 2), 16)
  if (nByte < 0x51 || nByte > 0x60) return null
  const n = nByte - 0x50

  if (n !== pubkeys.length || m > n) return null

  return { m, n, pubkeys }
}

// --- Utility ---

function hexToUtf8 (hex) {
  if (!hex) return ''
  const bytes = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return Buffer.from(bytes).toString('utf8')
}
