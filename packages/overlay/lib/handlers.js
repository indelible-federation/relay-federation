import { Transaction } from '@bsv/sdk'
import { verifyTxBroadcast } from './chain.js'

const SUPPORTED_PROVIDERS = new Set(['relay-topic-lookup'])

// Module-level cache; set via configureCors()
let _allowedOrigins = []

/**
 * Configure CORS allowed origins. Call before handling requests.
 * @param {string[]} origins — list of allowed origins (empty = allow all)
 */
export function configureCors (origins = []) {
  _allowedOrigins = origins
}

/**
 * Apply CORS headers. Restricted if configureCors() was called with origins,
 * otherwise allows all.
 */
export function applyCors (req, res) {
  const origin = req.headers.origin || '*'
  if (_allowedOrigins.length > 0) {
    if (_allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    }
    // If origin not allowed, omit the header — browser will block
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Expose-Headers', 'x-bsv-payment-version, x-bsv-payment-satoshis-required, x-bsv-payment-derivation-prefix')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bsv-payment, x-bsv-payment-version, x-overlay-auth, x-overlay-sync')
}

/**
 * POST /submit — BRC-22 transaction submission.
 *
 * Accepts both:
 *   BRC-22 canonical: { rawTx, inputs?, proof?, mapiResponses?, topics: [...] }
 *   Simplified:       { txHex, outputIndex }
 *
 * Response (BRC-22 style):
 *   { status: "success", topics: { "<topicName>": [outputIndex] } }
 *   or { status: "error", description: "..." }
 *
 * PHASE 1 LIMITATION: This endpoint accepts raw transaction bytes without
 * BRC-8 envelope verification (no BRC-9 SPV check, no proof validation,
 * no input chain verification). The topic manager validates BRC-48 format
 * and BRC-42 derivation but does not verify the transaction is confirmed
 * on-chain. Full BRC-8/BRC-9 validation is deferred to Phase 2.
 */
export async function handleSubmit (req, res, topicManager, sync = null, authVerifier = null) {
  const bodyString = await readBodyString(req)
  const body = safeParseJson(bodyString)

  // Check if this is an authenticated request
  const peerAuth = authVerifier ? authVerifier.verify(req, bodyString) : { valid: false }
  const isAuthenticated = peerAuth.valid
  // A sync propagation sets x-overlay-sync-origin header (only trusted if auth also passes)
  const fromPeerSync = isAuthenticated && req.headers['x-overlay-sync'] === 'true'

  // Support both BRC-22 canonical body and simplified body
  const rawTx = body.rawTx || body.txHex
  if (!rawTx) {
    res.writeHead(400)
    return res.end(JSON.stringify({ status: 'error', code: 'ERR_MISSING_TX', description: 'rawTx or txHex is required' }))
  }

  // If topics array provided (BRC-22 canonical), evaluate each mentioned output
  // If outputIndex provided (simplified), evaluate that single output
  let outputIndexes = []
  if (body.outputIndex !== undefined) {
    outputIndexes = [body.outputIndex]
  } else {
    // Parse tx to find potential SHIP outputs
    try {
      const tx = Transaction.fromHex(rawTx)
      outputIndexes = tx.outputs.map((_, i) => i)
    } catch {
      res.writeHead(400)
      return res.end(JSON.stringify({ status: 'error', code: 'ERR_INVALID_TX', description: 'Cannot parse transaction' }))
    }
  }

  const admittedTopics = {}
  let anyAdmitted = false

  let chainCheckFailed = null
  for (const idx of outputIndexes) {
    const result = topicManager.evaluate({ txHex: rawTx, outputIndex: idx })
    if (result.admitted) {
      // Skip chain check for authenticated requests (operator or peer already verified)
      const admitResult = await topicManager.admit(result.entry, { skipChainCheck: isAuthenticated })
      if (!admitResult.stored) {
        chainCheckFailed = admitResult.reason
        continue
      }
      const topic = result.entry.topic
      if (!admittedTopics[topic]) admittedTopics[topic] = []
      admittedTopics[topic].push(idx)
      anyAdmitted = true
    }
  }

  if (!anyAdmitted && chainCheckFailed) {
    res.writeHead(400)
    return res.end(JSON.stringify({ status: 'error', code: 'ERR_CHAIN_VERIFY', description: chainCheckFailed }))
  }

  if (!anyAdmitted) {
    res.writeHead(200)
    return res.end(JSON.stringify({ status: 'success', topics: {} }))
  }

  // Propagate to peer overlay nodes (best-effort, non-blocking)
  // Skip only if this is a peer sync (loop prevention) — operator CLI submits should propagate
  if (sync && sync.peerCount > 0 && !fromPeerSync) {
    for (const idx of Object.values(admittedTopics).flat()) {
      sync.propagateSubmit(rawTx, idx).catch(err => {
        console.warn('[Overlay] Sync propagate error:', err.message)
      })
    }
  }

  res.writeHead(200)
  res.end(JSON.stringify({ status: 'success', topics: admittedTopics }))
}

/**
 * POST /revoke — notify the overlay that a SHIP token has been spent.
 *
 * Body: { spendingTxHex: string, spentTxid: string, spentOutputIndex: number }
 *
 * The caller must provide the spending transaction that consumes the SHIP token.
 * The handler verifies the spending tx actually has an input referencing the
 * claimed outpoint before removing the entry.
 *
 * Response: { revoked: boolean, reason?: string }
 */
export async function handleRevoke (req, res, topicManager, sync = null, authVerifier = null) {
  const bodyString = await readBodyString(req)
  const body = safeParseJson(bodyString)
  const peerAuth = authVerifier ? authVerifier.verify(req, bodyString) : { valid: false }
  const isAuthenticated = peerAuth.valid
  const fromPeerSync = isAuthenticated && req.headers['x-overlay-sync'] === 'true'

  if (!body.spendingTxHex || !body.spentTxid || body.spentOutputIndex === undefined) {
    res.writeHead(400)
    return res.end(JSON.stringify({ revoked: false, reason: 'missing_fields: spendingTxHex, spentTxid, spentOutputIndex required' }))
  }

  // Parse the spending transaction and verify it consumes the claimed outpoint
  let spendingTx
  try {
    spendingTx = Transaction.fromHex(body.spendingTxHex)
  } catch {
    res.writeHead(400)
    return res.end(JSON.stringify({ revoked: false, reason: 'invalid_spending_tx' }))
  }

  const consumesOutpoint = spendingTx.inputs.some(input => {
    const sourceTxid = input.sourceTXID || (input.sourceTransaction ? input.sourceTransaction.id('hex') : null)
    return sourceTxid === body.spentTxid && input.sourceOutputIndex === body.spentOutputIndex
  })

  if (!consumesOutpoint) {
    res.writeHead(400)
    return res.end(JSON.stringify({ revoked: false, reason: 'spending_tx_does_not_consume_outpoint' }))
  }

  // Verify the spending tx is on-chain (skip for authenticated revocations)
  if (!isAuthenticated) {
    const spendTxid = spendingTx.id('hex')
    const chainStatus = await verifyTxBroadcast(spendTxid)
    if (!chainStatus.valid) {
      res.writeHead(400)
      return res.end(JSON.stringify({ revoked: false, reason: chainStatus.reason || 'spending_tx_not_on_chain' }))
    }
  }

  const revoked = await topicManager.revoke(body.spentTxid, body.spentOutputIndex)

  // Propagate revocation to peers (best-effort, non-blocking)
  if (revoked && sync && sync.peerCount > 0 && !fromPeerSync) {
    sync.propagateRevoke(body.spendingTxHex, body.spentTxid, body.spentOutputIndex).catch(err => {
      console.warn('[Overlay] Sync revoke propagation failed:', err.message)
    })
  }

  res.writeHead(200)
  res.end(JSON.stringify({ revoked }))
}

/**
 * POST /lookup — BRC-24 query resolution.
 *
 * Body: { provider: 'relay-topic-lookup', query: { ... } }
 *
 * Query shapes:
 *   { topic: 'oracle:rates:bsv' }   — find bridges carrying a topic
 *   { bridge: '02abc...' }           — find topics a bridge carries
 *   { list: 'topics' }               — list all topics with counts
 *   { list: 'all' }                  — full directory dump
 *
 * Response (BRC-24 style for topic/bridge/all queries):
 *   Array of BRC-36-shaped UTXO objects with overlay metadata.
 *
 * Response (for list: 'topics'):
 *   Array of { topic, count } summary objects.
 */
export async function handleLookup (req, res, lookupService, store) {
  const body = safeParseJson(await readBodyString(req))

  // BRC-24 requires 'provider' field
  const provider = body.provider || 'relay-topic-lookup'
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    res.writeHead(400)
    return res.end(JSON.stringify({
      status: 'error',
      code: 'ERR_LOOKUP_SERVICE_NOT_SUPPORTED',
      description: `Provider "${provider}" is not supported. Use "relay-topic-lookup".`
    }))
  }

  if (!body.query) {
    res.writeHead(400)
    return res.end(JSON.stringify({ status: 'error', code: 'ERR_MISSING_QUERY', description: 'query field is required' }))
  }

  const query = body.query
  let entries
  let isSummary = false

  if (query.topic) {
    entries = await lookupService.lookupByTopic(query.topic)
  } else if (query.bridge) {
    entries = await lookupService.lookupByBridge(query.bridge)
  } else if (query.list === 'topics') {
    const topics = await lookupService.listTopics()
    isSummary = true
    res.writeHead(200)
    return res.end(JSON.stringify({ type: 'topic-summary', results: topics }))
  } else if (query.list === 'all') {
    entries = await lookupService.listAll()
  } else {
    res.writeHead(400)
    return res.end(JSON.stringify({ status: 'error', code: 'ERR_UNSUPPORTED_QUERY', description: 'Unsupported query shape' }))
  }

  // Transform entries to BRC-36-style UTXO objects with overlay metadata
  const utxos = entries.map(entry => toBrc36(entry))

  res.writeHead(200)
  res.end(JSON.stringify({ type: 'output-list', outputs: utxos }))
}

/**
 * GET /status — overlay health check.
 */
export async function handleStatus (res, store) {
  const topics = await store.listTopics()
  const totalEntries = topics.reduce((sum, t) => sum + t.count, 0)

  res.writeHead(200)
  res.end(JSON.stringify({
    service: 'relay-directory-overlay',
    status: 'ok',
    topics: topics.length,
    entries: totalEntries
  }))
}

/**
 * Transform an internal SHIP entry to a BRC-36-style UTXO object.
 * Includes BRC-36 base fields plus overlay-specific metadata.
 */
function toBrc36 (entry) {
  const result = {
    // BRC-36 base fields
    txid: entry.txid,
    vout: entry.outputIndex,
    satoshis: entry.satoshis || 1,
    // Overlay metadata (extension fields — permitted by BRC-36)
    topic: entry.topic,
    domain: entry.domain,
    identityPubHex: entry.identityPubHex,
    lockingPubHex: entry.lockingPubHex
  }
  // Include outputScript and rawTx if stored (BRC-36 compliance)
  if (entry.outputScript) result.outputScript = entry.outputScript
  if (entry.rawTx) result.rawTx = entry.rawTx
  return result
}

/**
 * Read request body as a string.
 */
export function readBodyString (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

/**
 * Safely parse JSON, returning empty object on failure.
 */
function safeParseJson (str) {
  try { return JSON.parse(str) } catch { return {} }
}
