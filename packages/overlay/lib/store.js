import { Level } from 'level'

/**
 * Overlay data store backed by LevelDB.
 * Stores admitted SHIP token entries indexed by topic and by bridge (identity pubkey).
 *
 * Key schemes:
 *   ship:<txid>:<outputIndex>       → full entry JSON
 *   topic:<topic>:<txid>:<vout>     → '' (index for topic lookups)
 *   bridge:<pubkey>:<txid>:<vout>   → '' (index for bridge lookups)
 */
export class OverlayStore {
  constructor (dbPath) {
    this._db = new Level(dbPath, { valueEncoding: 'json' })
  }

  async open () {
    await this._db.open()
  }

  async close () {
    await this._db.close()
  }

  /**
   * Store an admitted SHIP entry with topic and bridge indexes.
   */
  async putShipEntry (entry) {
    const { txid, outputIndex, topic, identityPubHex } = entry
    const pk = `ship:${txid}:${outputIndex}`
    const topicKey = `topic:${topic}:${txid}:${outputIndex}`
    const bridgeKey = `bridge:${identityPubHex}:${txid}:${outputIndex}`

    const batch = this._db.batch()
    batch.put(pk, entry)
    batch.put(topicKey, '')
    batch.put(bridgeKey, '')
    await batch.write()
  }

  /**
   * Delete a SHIP entry and its indexes (revocation).
   * @returns {boolean} true if an entry was found and deleted
   */
  async deleteShipEntry (txid, outputIndex) {
    const pk = `ship:${txid}:${outputIndex}`
    let entry
    try {
      entry = await this._db.get(pk)
    } catch {
      return false
    }
    if (!entry) return false

    const topicKey = `topic:${entry.topic}:${txid}:${outputIndex}`
    const bridgeKey = `bridge:${entry.identityPubHex}:${txid}:${outputIndex}`

    const batch = this._db.batch()
    batch.del(pk)
    batch.del(topicKey)
    batch.del(bridgeKey)
    await batch.write()
    return true
  }

  /**
   * Get a single SHIP entry by outpoint.
   */
  async getShipEntry (txid, outputIndex) {
    try {
      const entry = await this._db.get(`ship:${txid}:${outputIndex}`)
      return entry ?? null
    } catch {
      return null
    }
  }

  /**
   * Find all SHIP entries for a given topic.
   * @param {string} topic
   * @returns {Promise<object[]>}
   */
  async findByTopic (topic) {
    const prefix = `topic:${topic}:`
    const entries = []
    for await (const [key] of this._db.iterator({ gte: prefix, lt: prefix + '\xff' })) {
      // key = topic:<topic>:<txid>:<outputIndex>
      const parts = key.split(':')
      const txid = parts[parts.length - 2]
      const outputIndex = parseInt(parts[parts.length - 1], 10)
      const entry = await this.getShipEntry(txid, outputIndex)
      if (entry) entries.push(entry)
    }
    return entries
  }

  /**
   * Find all SHIP entries for a given bridge identity.
   * @param {string} identityPubHex
   * @returns {Promise<object[]>}
   */
  async findByBridge (identityPubHex) {
    const prefix = `bridge:${identityPubHex}:`
    const entries = []
    for await (const [key] of this._db.iterator({ gte: prefix, lt: prefix + '\xff' })) {
      const parts = key.split(':')
      const txid = parts[parts.length - 2]
      const outputIndex = parseInt(parts[parts.length - 1], 10)
      const entry = await this.getShipEntry(txid, outputIndex)
      if (entry) entries.push(entry)
    }
    return entries
  }

  /**
   * List all topics with counts.
   * @returns {Promise<Array<{topic: string, count: number}>>}
   */
  async listTopics () {
    const topics = new Map()
    for await (const [key] of this._db.iterator({ gte: 'topic:', lt: 'topic:\xff' })) {
      // key = topic:<topic>:<txid>:<outputIndex>
      // Extract topic — everything between first and second-to-last colon groups
      const withoutPrefix = key.slice(6) // remove 'topic:'
      const lastColon2 = withoutPrefix.lastIndexOf(':')
      const lastColon1 = withoutPrefix.lastIndexOf(':', lastColon2 - 1)
      const topic = withoutPrefix.slice(0, lastColon1)
      topics.set(topic, (topics.get(topic) || 0) + 1)
    }
    return Array.from(topics.entries()).map(([topic, count]) => ({ topic, count }))
  }

  /**
   * Get all entries (for small overlays — not for production scale).
   * @returns {Promise<object[]>}
   */
  async listAll () {
    const entries = []
    for await (const [key, value] of this._db.iterator({ gte: 'ship:', lt: 'ship:\xff' })) {
      entries.push(value)
    }
    return entries
  }
}
