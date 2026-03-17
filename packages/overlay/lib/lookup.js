/**
 * Relay Topic Lookup Service (BRC-24 style).
 *
 * Provides query resolution over the admitted SHIP tokens.
 * Three query modes:
 *   - by topic: "who carries oracle:rates:bsv?"
 *   - by bridge: "what topics does bridge X carry?"
 *   - all topics: "what data topics exist on the mesh?"
 */
export class TopicLookupService {
  constructor (store) {
    this._store = store
  }

  /**
   * Lookup bridges that carry a specific topic.
   *
   * @param {string} topic
   * @returns {Promise<object[]>} — array of { identityPubHex, domain, topic, txid, outputIndex }
   */
  async lookupByTopic (topic) {
    return this._store.findByTopic(topic)
  }

  /**
   * Lookup all topics a specific bridge carries.
   *
   * @param {string} identityPubHex
   * @returns {Promise<object[]>}
   */
  async lookupByBridge (identityPubHex) {
    return this._store.findByBridge(identityPubHex)
  }

  /**
   * List all known topics with advertiser counts.
   *
   * @returns {Promise<Array<{topic: string, count: number}>>}
   */
  async listTopics () {
    return this._store.listTopics()
  }

  /**
   * List all entries (full directory dump — use with care at scale).
   *
   * @returns {Promise<object[]>}
   */
  async listAll () {
    return this._store.listAll()
  }
}
