import { createServer } from 'node:http'
import { OverlayStore } from './store.js'
import { ShipTopicManager } from './ship.js'
import { TopicLookupService } from './lookup.js'
import { OverlaySync } from './sync.js'
import { createPaymentGate, createPaymentVerifier, loadPricing } from './payment.js'
import { createAuthVerifier } from './auth.js'
import { configureCors, applyCors, handleSubmit, handleRevoke, handleLookup, handleStatus } from './handlers.js'

/**
 * Start an embedded overlay HTTP server.
 *
 * All configuration is passed via parameters — no direct process.env reads.
 * The caller (CLI, bridge, or standalone script) is responsible for
 * resolving config from env, files, or hardcoded values.
 */
export async function startOverlayServer ({
  port = 3360,
  dbPath = './data/overlay.db',
  peerUrls = [],
  identityKey = null,
  identityPubHex = null,
  trustedPubkeys = [],
  skipChainCheck = false,
  pricing = {},
  corsOrigins = []
} = {}) {
  const store = new OverlayStore(dbPath)
  await store.open()

  const topicManager = new ShipTopicManager(store, { skipChainCheck })
  const lookupService = new TopicLookupService(store)

  // CORS
  configureCors(corsOrigins)

  // Auth
  const trusted = new Set(trustedPubkeys)
  if (identityPubHex) trusted.add(identityPubHex)
  const authVerifier = trusted.size > 0 ? createAuthVerifier({ trustedPubkeys: trusted }) : null

  // Sync
  const sync = new OverlaySync({ peerUrls, identityKey })

  // Payment
  const resolvedPricing = loadPricing(pricing)
  let verifyPayment = null
  const anyPriced = resolvedPricing.submit > 0 || resolvedPricing.lookup > 0 || resolvedPricing.revoke > 0
  if (anyPriced && identityKey) {
    verifyPayment = createPaymentVerifier(identityKey, { skipChainCheck })
  }
  const submitGate = createPaymentGate({ satoshis: resolvedPricing.submit, description: 'SHIP token listing fee', verifyPayment })
  const lookupGate = createPaymentGate({ satoshis: resolvedPricing.lookup, description: 'Directory lookup fee', verifyPayment })
  const revokeGate = createPaymentGate({ satoshis: resolvedPricing.revoke, description: 'Revocation fee', verifyPayment })

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    applyCors(req, res)

    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname

    try {
      if (req.method === 'POST' && path === '/submit') {
        if (await submitGate(req, res)) await handleSubmit(req, res, topicManager, sync, authVerifier)
      } else if (req.method === 'POST' && path === '/revoke') {
        if (await revokeGate(req, res)) await handleRevoke(req, res, topicManager, sync, authVerifier)
      } else if (req.method === 'POST' && path === '/lookup') {
        if (await lookupGate(req, res)) await handleLookup(req, res, lookupService, store)
      } else if (req.method === 'GET' && path === '/status') {
        await handleStatus(res, store)
      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'not_found' }))
      }
    } catch (err) {
      console.error('[Overlay] Request error:', err.message)
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'internal_error', message: err.message }))
    }
  })

  server.listen(port, () => {
    console.log(`[Overlay] Running on port ${port}`)
    console.log(`[Overlay] DB: ${dbPath}`)
    if (sync.peerCount > 0) console.log(`[Overlay] Sync: ${sync.peerCount} peer(s)`)
    if (anyPriced) console.log(`[Overlay] Pricing: submit=${resolvedPricing.submit} lookup=${resolvedPricing.lookup} revoke=${resolvedPricing.revoke} sats`)
  })

  return { server, store, topicManager, lookupService, sync }
}
