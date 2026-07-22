import { Level } from 'level'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises'

/**
 * PersistentStore — LevelDB-backed storage for bridge state.
 *
 * Stores headers, transactions, and arbitrary metadata in sublevel
 * namespaces. Replaces the in-memory Maps used by HeaderRelay and
 * TxRelay with durable storage that survives restarts.
 *
 * Sublevels:
 *   headers    — height → { height, hash, prevHash }
 *   txs        — txid → rawHex
 *   utxos      — txid:vout → { txid, vout, satoshis, scriptHex, address, spent }
 *   meta       — key → value (bestHeight, bestHash, etc.)
 *   watched    — txid → { txid, address, direction, timestamp }
 *
 * Events:
 *   'open'  — store ready
 *   'error' — LevelDB error
 */
export class PersistentStore extends EventEmitter {
  /**
   * @param {string} dataDir — directory for the LevelDB database
   */
  constructor (dataDir) {
    super()
    this.dbPath = join(dataDir, 'bridge.db')
    this.db = null
    this._headers = null
    this._txs = null
    this._utxos = null
    this._meta = null
    this._watched = null
    this._hashIndex = null
    this._inscriptions = null
    this._inscriptionIdx = null
    this._txStatus = null
    this._txBlock = null
    this._content = null
    this._tokens = null
    this._paymentReceipts = null
    this._spentInputs = null
    this._contentDir = join(dataDir, 'content')
  }

  /** Open the database and create sublevels. */
  async open () {
    let retried = false
    while (true) {
      try {
        this.db = new Level(this.dbPath, { valueEncoding: 'json' })
        await this.db.open()
        this._headers = this.db.sublevel('headers', { valueEncoding: 'json' })
        this._txs = this.db.sublevel('txs', { valueEncoding: 'utf8' })
        this._utxos = this.db.sublevel('utxos', { valueEncoding: 'json' })
        this._meta = this.db.sublevel('meta', { valueEncoding: 'json' })
        this._watched = this.db.sublevel('watched', { valueEncoding: 'json' })
        this._hashIndex = this.db.sublevel('hashIndex', { valueEncoding: 'json' })
        this._inscriptions = this.db.sublevel('inscriptions', { valueEncoding: 'json' })
        this._inscriptionIdx = this.db.sublevel('inscIdx', { valueEncoding: 'json' })
        this._txStatus = this.db.sublevel('txStatus', { valueEncoding: 'json' })
        this._txBlock = this.db.sublevel('txBlock', { valueEncoding: 'json' })
        this._content = this.db.sublevel('content', { valueEncoding: 'json' })
        this._tokens = this.db.sublevel('tokens', { valueEncoding: 'json' })
        this._paymentReceipts = this.db.sublevel('payment_receipts', { valueEncoding: 'json' })
        this._spentInputs = this.db.sublevel('spentInputs', { valueEncoding: 'json' })
        await mkdir(this._contentDir, { recursive: true })
        this.emit('open')
        break
      } catch (err) {
        // Auto-heal corrupted database (once)
        const isCorruption = err.message && (
          err.message.includes('Corruption') ||
          err.message.includes('missing files') ||
          err.message.includes('MANIFEST') ||
          err.message.includes('bad magic number') ||
          err.message.includes('sstable') ||
          err.message.includes('LOCK')
        )
        if (isCorruption && !retried) {
          console.error(`[WARNING] Database corruption detected: ${err.message}`)
          console.error(`[WARNING] PID:${process.pid} - Renaming corrupted DB and rebuilding from P2P`)
          const badDbPath = `${this.dbPath}.bad-${Date.now()}`
          try {
            await rename(this.dbPath, badDbPath)
            console.log(`[RECOVERY] Corrupted DB moved to: ${badDbPath}`)
            console.log(`[RECOVERY] Creating fresh DB - will rebuild from P2P peers`)
            retried = true
            continue
          } catch (renameErr) {
            console.error(`[FATAL] Failed to rename corrupted DB: ${renameErr.message}`)
            throw err
          }
        }
        throw err
      }
    }
  }

  /** Close the database. */
  async close () {
    if (this.db) await this.db.close()
  }

  // ── Headers ──────────────────────────────────────────────

  /**
   * Store a header by height (with hash index).
   * @param {{ height: number, hash: string, prevHash: string, merkleRoot?: string, timestamp?: number, bits?: number, nonce?: number, version?: number }} header
   */
  async putHeader (header) {
    await this._headers.put(String(header.height), header)
    if (header.hash) {
      await this._hashIndex.put(header.hash, header.height)
    }
  }

  /**
   * Store multiple headers in a batch (with hash index).
   * @param {Array<{ height: number, hash: string, prevHash: string, merkleRoot?: string, timestamp?: number, bits?: number, nonce?: number, version?: number }>} headers
   */
  async putHeaders (headers) {
    const headerOps = headers.map(h => ({
      type: 'put',
      key: String(h.height),
      value: h
    }))
    await this._headers.batch(headerOps)
    const hashOps = headers.filter(h => h.hash).map(h => ({
      type: 'put',
      key: h.hash,
      value: h.height
    }))
    if (hashOps.length > 0) {
      await this._hashIndex.batch(hashOps)
    }
  }

  /**
   * Get a header by height.
   * @param {number} height
   * @returns {Promise<{ height: number, hash: string, prevHash: string }|null>}
   */
  async getHeader (height) {
    const val = await this._headers.get(String(height))
    return val !== undefined ? val : null
  }

  /**
   * Get a header by block hash.
   * @param {string} hash
   * @returns {Promise<object|null>}
   */
  async getHeaderByHash (hash) {
    const height = await this._hashIndex.get(hash)
    if (height === undefined) return null
    return this.getHeader(height)
  }

  /**
   * Verify a merkle proof against a stored block header.
   * @param {string} txHash — transaction hash (hex, display order)
   * @param {string[]} merkleProof — sibling hashes in the merkle path
   * @param {number} txIndex — transaction index in the block
   * @param {string} blockHash — block hash to verify against
   * @returns {Promise<{ verified: boolean, blockHeight: number, blockTimestamp: number }>}
   */
  async verifyMerkleProof (txHash, merkleProof, txIndex, blockHash) {
    const header = await this.getHeaderByHash(blockHash)
    if (!header) {
      throw new Error(`Block ${blockHash} not found in header chain`)
    }
    if (!header.merkleRoot) {
      throw new Error(`Header at height ${header.height} has no merkleRoot stored`)
    }

    // Compute merkle root from proof
    let hash = Buffer.from(txHash, 'hex').reverse()
    let index = txIndex

    for (const proofHash of merkleProof) {
      const sibling = Buffer.from(proofHash, 'hex').reverse()
      const combined = (index % 2 === 0)
        ? Buffer.concat([hash, sibling])
        : Buffer.concat([sibling, hash])
      hash = doubleSha256(combined)
      index = Math.floor(index / 2)
    }

    const calculatedRoot = hash.reverse().toString('hex')

    if (calculatedRoot !== header.merkleRoot) {
      throw new Error('Merkle proof verification failed')
    }

    return {
      verified: true,
      blockHash: header.hash,
      blockHeight: header.height,
      blockTimestamp: header.timestamp
    }
  }

  // ── Transactions ─────────────────────────────────────────

  /**
   * Store a raw transaction.
   * @param {string} txid
   * @param {string} rawHex
   */
  async putTx (txid, rawHex) {
    await this._txs.put(txid, rawHex)
  }

  /**
   * Get a raw transaction by txid.
   * @param {string} txid
   * @returns {Promise<string|null>} rawHex or null
   */
  async getTx (txid) {
    const val = await this._txs.get(txid)
    return val !== undefined ? val : null
  }

  /**
   * Delete a raw transaction from local store (after blockchain confirmation).
   * @param {string} txid
   */
  async deleteTx (txid) {
    try { await this._txs.del(txid) } catch {}
  }

  /**
   * Iterate all stored txids (for cleanup).
   * @returns {AsyncIterable<string>} txid keys
   */
  async * listTxIds () {
    for await (const key of this._txs.keys()) {
      yield key
    }
  }

  /**
   * Check if a transaction exists.
   * @param {string} txid
   * @returns {Promise<boolean>}
   */
  async hasTx (txid) {
    return (await this.getTx(txid)) !== null
  }

  // ── UTXOs ────────────────────────────────────────────────

  /**
   * Store a UTXO.
   * @param {{ txid: string, vout: number, satoshis: number, scriptHex: string, address: string }} utxo
   */
  async putUtxo (utxo) {
    const key = `${utxo.txid}:${utxo.vout}`
    await this._utxos.put(key, { ...utxo, spent: false, addedAt: Date.now() })
  }

  /**
   * Mark a UTXO as spent.
   * @param {string} txid
   * @param {number} vout
   */
  async spendUtxo (txid, vout) {
    const key = `${txid}:${vout}`
    const utxo = await this._utxos.get(key)
    if (utxo === undefined) return
    utxo.spent = true
    await this._utxos.put(key, utxo)
  }

  /**
   * Delete a UTXO record entirely (for ghost cleanup).
   * @param {string} txid
   * @param {number} vout
   */
  async deleteUtxo (txid, vout) {
    const key = `${txid}:${vout}`
    try { await this._utxos.del(key) } catch {}
  }

  /**
   * List unique txids from all unspent UTXOs (for cleanup validation).
   * @returns {Promise<string[]>}
   */
  async listUnspentUtxoTxIds () {
    const txids = new Set()
    for await (const [, utxo] of this._utxos.iterator()) {
      if (!utxo.spent) txids.add(utxo.txid)
    }
    return [...txids]
  }

  /**
   * Get all unspent UTXOs for a given txid (for cleanup).
   * @param {string} txid
   * @returns {Promise<Array<{ txid: string, vout: number }>>}
   */
  async getUnspentByTxId (txid) {
    const utxos = []
    for await (const [, utxo] of this._utxos.iterator()) {
      if (!utxo.spent && utxo.txid === txid) utxos.push(utxo)
    }
    return utxos
  }

  /**
   * Get all unspent UTXOs.
   * @returns {Promise<Array<{ txid: string, vout: number, satoshis: number, scriptHex: string, address: string }>>}
   */
  async getUnspentUtxos () {
    const utxos = []
    for await (const [, utxo] of this._utxos.iterator()) {
      if (!utxo.spent) utxos.push(utxo)
    }
    return utxos
  }

  /**
   * Get unspent UTXOs for a specific address.
   * @param {string} address
   * @returns {Promise<Array<{ txid: string, vout: number, satoshis: number, scriptHex: string, address: string }>>}
   */
  async getUnspentByAddress (address) {
    const utxos = []
    for await (const [, utxo] of this._utxos.iterator()) {
      if (!utxo.spent && utxo.address === address) utxos.push(utxo)
    }
    return utxos
  }

  /**
   * Get total unspent balance in satoshis.
   * @returns {Promise<number>}
   */
  async getBalance () {
    let total = 0
    for await (const [, utxo] of this._utxos.iterator()) {
      if (!utxo.spent) total += utxo.satoshis
    }
    return total
  }

  // ── Spent inputs (broadcast-time negative cache) ───────

  /**
   * Mark a UTXO as spent by a broadcast tx (first-writer-wins).
   * @param {string} txid — the UTXO's txid being spent
   * @param {number} vout — the UTXO's output index being spent
   * @param {string} spentByTxid — the spending tx's txid
   */
  async markInputSpent (txid, vout, spentByTxid) {
    const key = `${txid}:${vout}`
    try {
      const existing = await this._spentInputs.get(key)
      if (existing) return // first-writer-wins
    } catch {}
    await this._spentInputs.put(key, { spentByTxid, timestamp: Date.now() })
  }

  /**
   * Check if a UTXO has been marked as spent by a local broadcast.
   * @param {string} txid
   * @param {number} vout
   * @returns {Promise<boolean>}
   */
  async isInputSpent (txid, vout) {
    const key = `${txid}:${vout}`
    try {
      const entry = await this._spentInputs.get(key)
      return !!entry
    } catch {
      return false
    }
  }

  /**
   * Clear a false spent-input entry (e.g. when GP confirms UTXO is unspent).
   * @param {string} txid
   * @param {number} vout
   */
  async clearSpentInput (txid, vout) {
    const key = `${txid}:${vout}`
    try { await this._spentInputs.del(key) } catch {}
  }

  /**
   * Prune spent input entries older than maxAgeMs (default 2 hours).
   * @param {number} [maxAgeMs=7200000]
   */
  async pruneSpentInputs (maxAgeMs = 7200000) {
    const cutoff = Date.now() - maxAgeMs
    const batch = this._spentInputs.batch()
    for await (const [key, entry] of this._spentInputs.iterator()) {
      if (entry.timestamp < cutoff) batch.del(key)
    }
    await batch.write()
  }

  // ── Watched address matches ──────────────────────────────

  /**
   * Store a watched-address match (a tx that touched a watched address).
   * @param {{ txid: string, address: string, direction: 'in'|'out', timestamp: number }} match
   */
  async putWatchedTx (match) {
    const key = `${match.address}:${match.txid}`
    await this._watched.put(key, match)
  }

  /**
   * Get all watched-address matches for an address.
   * @param {string} address
   * @returns {Promise<Array>}
   */
  async getWatchedTxs (address) {
    const matches = []
    for await (const [key, value] of this._watched.iterator()) {
      if (key.startsWith(`${address}:`)) {
        matches.push(value)
      }
    }
    return matches
  }

  // ── Metadata ─────────────────────────────────────────────

  /**
   * Store a metadata value.
   * @param {string} key
   * @param {*} value — any JSON-serializable value
   */
  async putMeta (key, value) {
    await this._meta.put(key, value)
  }

  /**
   * Get a metadata value.
   * @param {string} key
   * @param {*} [defaultValue=null]
   * @returns {Promise<*>}
   */
  async getMeta (key, defaultValue = null) {
    const val = await this._meta.get(key)
    return val !== undefined ? val : defaultValue
  }
  // ── Tx Status + Block Mapping ───────────────────────────

  /**
   * Set or update tx lifecycle state.
   * @param {string} txid
   * @param {'mempool'|'confirmed'|'orphaned'|'dropped'} state
   * @param {object} [meta] — optional fields: blockHash, height, source
   */
  async updateTxStatus (txid, state, meta = {}) {
    const key = `s!${txid}`
    const now = Date.now()
    let existing = null
    try {
      const val = await this._txStatus.get(key)
      if (val !== undefined) existing = val
    } catch {}

    const record = existing || { firstSeen: now }
    record.state = state
    record.lastSeen = now
    record.updatedAt = now
    if (meta.blockHash) record.blockHash = meta.blockHash
    if (meta.height !== undefined) record.height = meta.height
    if (meta.source) record.source = meta.source

    const batch = [{ type: 'put', key, value: record }]

    // Maintain mempool secondary index
    if (state === 'mempool') {
      batch.push({ type: 'put', key: `mempool!${txid}`, value: 1 })
    } else if (existing?.state === 'mempool') {
      batch.push({ type: 'del', key: `mempool!${txid}` })
    }

    await this._txStatus.batch(batch)
    return record
  }

  /**
   * Get tx lifecycle state.
   * @param {string} txid
   * @returns {Promise<object|null>}
   */
  async getTxStatus (txid) {
    try {
      const val = await this._txStatus.get(`s!${txid}`)
      return val !== undefined ? val : null
    } catch { return null }
  }

  /**
   * Confirm a tx — atomic batch: txBlock + reverse index + txStatus update.
   * @param {string} txid
   * @param {string} blockHash
   * @param {number} height
   * @param {{ nodes: string[], index: number }|null} proof
   */
  async confirmTx (txid, blockHash, height, proof = null) {
    const now = Date.now()
    const blockRecord = { blockHash, height, confirmedAt: now, verified: !!proof }
    if (proof) blockRecord.proof = proof

    // Atomic batch across txBlock + txStatus
    const txBlockBatch = [
      { type: 'put', key: `tx!${txid}`, value: blockRecord },
      { type: 'put', key: `block!${blockHash}!tx!${txid}`, value: 1 }
    ]
    await this._txBlock.batch(txBlockBatch)

    await this.updateTxStatus(txid, 'confirmed', { blockHash, height })
    this.emit('tx:confirmed', { txid, blockHash, height })
  }

  /**
   * Get tx block placement.
   * @param {string} txid
   * @returns {Promise<object|null>}
   */
  async getTxBlock (txid) {
    try {
      const val = await this._txBlock.get(`tx!${txid}`)
      return val !== undefined ? val : null
    } catch { return null }
  }

  /**
   * Handle reorg — mark all txs in disconnected block as orphaned.
   * @param {string} blockHash — the disconnected block hash
   * @returns {Promise<string[]>} list of affected txids
   */
  async handleReorg (blockHash) {
    const affected = []
    const prefix = `block!${blockHash}!tx!`

    // Find all txids in this block via reverse index
    for await (const [key] of this._txBlock.iterator({ gte: prefix, lt: prefix + '~' })) {
      const txid = key.slice(prefix.length)
      affected.push(txid)
    }

    // Mark each as orphaned + clean up block associations
    for (const txid of affected) {
      await this.updateTxStatus(txid, 'orphaned', { blockHash })
      await this._txBlock.del(`tx!${txid}`)
      await this._txBlock.del(`block!${blockHash}!tx!${txid}`)
    }

    return affected
  }

  // ── Content-Addressed Storage ───────────────────────────

  static CAS_THRESHOLD = 4096 // 4KB — below this, inline in LevelDB

  /**
   * Store content bytes via CAS. Small content inline, large to filesystem.
   * @param {string} hexContent — hex-encoded content bytes
   * @param {string} [mime] — content type
   * @returns {Promise<{ contentHash: string, contentLen: number, contentPath: string|null, inline: boolean }>}
   */
  async putContent (hexContent, mime) {
    const buf = Buffer.from(hexContent, 'hex')
    const contentHash = createHash('sha256').update(buf).digest('hex')
    const contentLen = buf.length
    const inline = contentLen < PersistentStore.CAS_THRESHOLD

    const record = { len: contentLen, mime: mime || null, createdAt: Date.now() }

    if (inline) {
      record.inline = hexContent
      record.path = null
    } else {
      const dir = join(this._contentDir, contentHash.slice(0, 2))
      const filePath = join(dir, contentHash)
      await mkdir(dir, { recursive: true })
      await writeFile(filePath, buf)
      record.path = filePath
    }

    await this._content.put(`c!${contentHash}`, record)
    return { contentHash, contentLen, contentPath: record.path, inline }
  }

  /**
   * Get content bytes by hash.
   * @param {string} contentHash
   * @returns {Promise<Buffer|null>}
   */
  async getContentBytes (contentHash) {
    let record
    try {
      const val = await this._content.get(`c!${contentHash}`)
      if (val === undefined) return null
      record = val
    } catch { return null }

    if (record.inline) {
      return Buffer.from(record.inline, 'hex')
    }
    if (record.path) {
      try { return await readFile(record.path) } catch { return null }
    }
    return null
  }

  /**
   * Get content metadata by hash.
   * @param {string} contentHash
   * @returns {Promise<object|null>}
   */
  async getContentMeta (contentHash) {
    try {
      const val = await this._content.get(`c!${contentHash}`)
      return val !== undefined ? val : null
    } catch { return null }
  }

  // ── Token Tracking (BSV-20) ─────────────────────────────

  /**
   * Process a BSV-20 token operation (confirmed-only).
   * Uses atomic batch() for all writes. Keyed by scriptHash for owner identity.
   * @param {{ op: string, tick: string, amt: string, ownerScriptHash: string, address: string|null, txid: string, height: number, blockHash: string }} params
   * @returns {Promise<{ valid: boolean, reason?: string }>}
   */
  async processTokenOp ({ op, tick, amt, ownerScriptHash, address, txid, height, blockHash }) {
    const tickNorm = tick.toLowerCase().trim()

    if (op === 'deploy') {
      // Only first deploy counts (chain-ordered by height)
      const existing = await this._safeGet(this._tokens, `tick!${tickNorm}`)
      if (existing) return { valid: false, reason: 'already deployed' }

      const parsed = typeof amt === 'object' ? amt : {}
      const batch = [
        { type: 'put', key: `tick!${tickNorm}`, value: {
          tick: tickNorm, max: parsed.max || '0', lim: parsed.lim || '0',
          dec: parsed.dec || '0', deployer: ownerScriptHash, deployerAddr: address,
          deployTxid: txid, deployHeight: height, totalMinted: '0'
        }},
        { type: 'put', key: `op!${String(height).padStart(10, '0')}!${txid}!deploy`, value: {
          tick: tickNorm, op: 'deploy', ownerScriptHash, valid: true
        }}
      ]
      await this._tokens.batch(batch)
      return { valid: true }
    }

    if (op === 'mint') {
      const deploy = await this._safeGet(this._tokens, `tick!${tickNorm}`)
      if (!deploy) return { valid: false, reason: 'token not deployed' }

      const mintAmt = BigInt(amt || '0')
      if (mintAmt <= 0n) return { valid: false, reason: 'invalid amount' }
      if (deploy.lim !== '0' && mintAmt > BigInt(deploy.lim)) return { valid: false, reason: 'exceeds mint limit' }

      const newTotal = BigInt(deploy.totalMinted) + mintAmt
      if (deploy.max !== '0' && newTotal > BigInt(deploy.max)) return { valid: false, reason: 'exceeds max supply' }

      // Credit owner balance
      const balKey = `bal!${tickNorm}!owner!${ownerScriptHash}`
      const existing = await this._safeGet(this._tokens, balKey) || { confirmed: '0' }
      const newBal = (BigInt(existing.confirmed) + mintAmt).toString()

      const batch = [
        { type: 'put', key: `tick!${tickNorm}`, value: { ...deploy, totalMinted: newTotal.toString() } },
        { type: 'put', key: balKey, value: { confirmed: newBal, updatedAt: Date.now() } },
        { type: 'put', key: `op!${String(height).padStart(10, '0')}!${txid}!mint`, value: {
          tick: tickNorm, op: 'mint', amt: amt, ownerScriptHash, valid: true
        }}
      ]
      await this._tokens.batch(batch)
      return { valid: true }
    }

    // Transfers deferred to Phase 2
    return { valid: false, reason: 'transfers not yet supported' }
  }

  /**
   * Get token deploy info.
   * @param {string} tick
   * @returns {Promise<object|null>}
   */
  async getToken (tick) {
    return this._safeGet(this._tokens, `tick!${tick.toLowerCase().trim()}`)
  }

  /**
   * Get token balance for an owner.
   * @param {string} tick
   * @param {string} ownerScriptHash
   * @returns {Promise<string>} balance as string
   */
  async getTokenBalance (tick, ownerScriptHash) {
    const record = await this._safeGet(this._tokens, `bal!${tick.toLowerCase().trim()}!owner!${ownerScriptHash}`)
    return record ? record.confirmed : '0'
  }

  /**
   * List all deployed tokens.
   * @returns {Promise<Array>}
   */
  async listTokens () {
    const tokens = []
    const prefix = 'tick!'
    for await (const [key, value] of this._tokens.iterator({ gte: prefix, lt: prefix + '~' })) {
      tokens.push(value)
    }
    return tokens
  }

  /** Safe get — returns null instead of throwing for missing keys. */
  async _safeGet (sublevel, key) {
    try {
      const val = await sublevel.get(key)
      return val !== undefined ? val : null
    } catch { return null }
  }

  // ── Inscriptions ─────────────────────────────────────────

  /**
   * Store an inscription record with secondary indexes.
   * @param {{ txid: string, vout: number, contentType: string, contentSize: number, isBsv20: boolean, bsv20: object|null, timestamp: number, address: string|null }} record
   */
  async putInscription (record) {
    const key = `${record.txid}:${record.vout}`
    const suffix = `${record.txid}:${record.vout}`

    // Purge ALL stale secondary index entries pointing to this key
    try {
      const delBatch = []
      for await (const [idxKey, val] of this._inscriptionIdx.iterator()) {
        if (val === key && idxKey.endsWith(suffix)) delBatch.push({ type: 'del', key: idxKey })
      }
      if (delBatch.length) await this._inscriptionIdx.batch(delBatch)
    } catch {}

    // Route content through CAS
    if (record.content) {
      try {
        const cas = await this.putContent(record.content, record.contentType)
        record.contentHash = cas.contentHash
        record.contentLen = cas.contentLen
        // Strip raw content from inscription record if large (stored on filesystem)
        if (!cas.inline) {
          delete record.content
        }
      } catch {}
    }

    await this._inscriptions.put(key, record)

    const ts = String(record.timestamp).padStart(15, '0')
    const batch = [{ type: 'put', key: `time:${ts}:${suffix}`, value: key }]
    if (record.contentType) {
      batch.push({ type: 'put', key: `mime:${record.contentType}:${ts}:${suffix}`, value: key })
    }
    if (record.address) {
      batch.push({ type: 'put', key: `addr:${record.address}:${ts}:${suffix}`, value: key })
    }
    await this._inscriptionIdx.batch(batch)
  }

  /**
   * Query inscriptions with optional filters.
   * @param {{ mime?: string, address?: string, limit?: number }} opts
   * @returns {Promise<Array>}
   */
  async getInscriptions ({ mime, address, limit = 50 } = {}) {
    const results = []
    let prefix
    if (address) {
      prefix = `addr:${address}:`
    } else if (mime) {
      prefix = `mime:${mime}:`
    } else {
      prefix = 'time:'
    }

    for await (const [, primaryKey] of this._inscriptionIdx.iterator({
      gte: prefix, lt: prefix + '~', reverse: true, limit
    })) {
      try {
        const record = await this._inscriptions.get(primaryKey)
        if (record) {
          // Strip content from list results (can be 400KB+ per image)
          const { content, ...meta } = record
          results.push(meta)
        }
      } catch {}
    }
    return results
  }

  /**
   * Rebuild inscription secondary indexes from primary records.
   * Clears all index entries and re-creates from source of truth.
   * @returns {Promise<number>} count of inscriptions re-indexed
   */
  async rebuildInscriptionIndex () {
    // Clear entire index
    for await (const [key] of this._inscriptionIdx.iterator()) {
      await this._inscriptionIdx.del(key)
    }
    // Re-create from primary records
    let count = 0
    for await (const [, record] of this._inscriptions.iterator()) {
      const ts = String(record.timestamp).padStart(15, '0')
      const suffix = `${record.txid}:${record.vout}`
      const key = suffix
      const batch = [{ type: 'put', key: `time:${ts}:${suffix}`, value: key }]
      if (record.contentType) batch.push({ type: 'put', key: `mime:${record.contentType}:${ts}:${suffix}`, value: key })
      if (record.address) batch.push({ type: 'put', key: `addr:${record.address}:${ts}:${suffix}`, value: key })
      await this._inscriptionIdx.batch(batch)
      count++
    }
    return count
  }

  /**
   * Get a single inscription record (with content) by txid:vout.
   * @param {string} txid
   * @param {number} vout
   * @returns {Promise<object|null>}
   */
  async getInscription (txid, vout) {
    try {
      return await this._inscriptions.get(`${txid}:${vout}`)
    } catch {
      return null
    }
  }

  /**
   * Get total inscription count.
   * @returns {Promise<number>}
   */
  async getInscriptionCount () {
    let count = 0
    for await (const _ of this._inscriptions.keys()) count++
    return count
  }

  // ── x402 Payment Receipts ──────────────────────────────

  /**
   * Atomic claim — put-if-absent. Returns { ok: true } if claimed,
   * { ok: false } if txid already exists (replay blocked).
   *
   * abstract-level has NO `ifNotExists` put option — it is silently ignored, so a
   * naive put ALWAYS claims (every replay overwrites the prior claim and re-passes
   * the gate). Emulated atomically instead: LevelDB is single-process (it holds an
   * exclusive lock on its directory, so no second process can open this store), and
   * the in-process lock below makes the get→put critical section non-interleavable
   * for the same txid within the process. That is sufficient here — a cross-process
   * lock would be unreachable, because the backing store cannot be opened twice.
   */
  async claimTxid (txid, { routeKey, price, createdAt }) {
    const key = `u!${txid}`
    if (!this._claimLocks) this._claimLocks = new Set()
    if (this._claimLocks.has(key)) return { ok: false }
    this._claimLocks.add(key)
    try {
      const existing = await this._paymentReceipts.get(key).catch(() => undefined)
      if (existing != null) return { ok: false }
      await this._paymentReceipts.put(key, { status: 'claimed', routeKey, price, createdAt })
      return { ok: true }
    } catch (err) {
      console.error(`[x402] unexpected claimTxid error for ${txid}:`, err.message)
      return { ok: false }
    } finally {
      this._claimLocks.delete(key)
    }
  }

  /**
   * Release a claim (verification failed). Only deletes if status is 'claimed'.
   * Never deletes receipts — finalized payments are permanent.
   */
  async releaseClaim (txid) {
    const key = `u!${txid}`
    try {
      const val = await this._paymentReceipts.get(key)
      if (val && val.status === 'claimed') await this._paymentReceipts.del(key)
    } catch {}
  }

  /**
   * Promote claim to permanent receipt. Overwrites in-place — key is
   * NEVER deleted after this, blocking replay permanently.
   */
  async finalizePayment (txid, receipt) {
    await this._paymentReceipts.put(`u!${txid}`, { ...receipt, status: 'receipt' })
  }

  /**
   * Read a payment record (claim or receipt). Returns null if absent. Lets the gate
   * inspect an existing receipt on a claim conflict (fulfillment-aware retry) without
   * touching the permanence invariant.
   */
  async getPaymentReceipt (txid) {
    try {
      return await this._paymentReceipts.get(`u!${txid}`) || null
    } catch (err) {
      // Absent key = legitimate null. A REAL DB error must be visible, not masked as "not found"
      // (callers still treat null as fail-safe "deny the retry" — but the failure is now logged).
      if (!(err && (err.code === 'LEVEL_NOT_FOUND' || err.notFound))) {
        console.error(`[x402] getPaymentReceipt DB error for ${txid}:`, err && err.message)
      }
      return null
    }
  }

  /**
   * Mark a fulfillment-aware receipt as fulfilled (the service delivered a truthful
   * answer). Flips the flag IN PLACE — the key is never deleted, so replay protection
   * is untouched. Idempotent; no-op for claims / missing keys. Callers AWAIT this so a
   * credit can't silently stay open after we answer. Never throws — returns false + logs
   * LOUDLY on failure (an unconsumed credit = free re-serves of this answer until the
   * store recovers; that must be visible, not swallowed).
   */
  async markFulfilled (txid) {
    const key = `u!${txid}`
    try {
      const val = await this._paymentReceipts.get(key)
      if (val && val.status === 'receipt' && val.fulfilled === false) {
        await this._paymentReceipts.put(key, { ...val, fulfilled: true, fulfilledAt: Date.now() })
      }
      return true
    } catch (err) {
      console.error(`[x402][ALERT] markFulfilled FAILED for ${txid} — credit remains redeemable:`, err.message)
      return false
    }
  }

  /**
   * Startup sweep — delete stale claims older than maxAgeMs (default 5 min).
   * Only touches status === 'claimed' keys. Receipts are untouched.
   */
  async cleanupStaleClaims (maxAgeMs = 300000) {
    const now = Date.now()
    for await (const [key, val] of this._paymentReceipts.iterator({ gte: 'u!', lt: 'u~' })) {
      if (val.status !== 'claimed') continue
      if (!val.createdAt || (now - val.createdAt) > maxAgeMs)
        await this._paymentReceipts.del(key)
    }
  }

  /**
   * Prune old receipts — chunked batch deletes for receipts older than N months.
   */
  async pruneOldReceipts (monthsToKeep = 6) {
    const cutoffMs = Date.now() - (monthsToKeep * 30 * 24 * 60 * 60 * 1000)
    const CHUNK = 500
    let ops = []
    for await (const [key, val] of this._paymentReceipts.iterator({ gte: 'u!', lt: 'u~' })) {
      if (val.status !== 'receipt') continue
      if (val.createdAt && val.createdAt < cutoffMs) {
        ops.push({ type: 'del', key })
        if (ops.length >= CHUNK) { await this._paymentReceipts.batch(ops); ops = [] }
      }
    }
    if (ops.length > 0) await this._paymentReceipts.batch(ops)
  }
}

/** Double SHA-256 (Bitcoin standard) */
function doubleSha256 (data) {
  return createHash('sha256').update(
    createHash('sha256').update(data).digest()
  ).digest()
}
