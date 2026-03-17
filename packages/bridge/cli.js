#!/usr/bin/env node

import { join } from 'node:path'
import { initConfig, loadConfig, configExists, defaultConfigDir } from './lib/config.js'
import { PeerManager } from './lib/peer-manager.js'
import { HeaderRelay } from './lib/header-relay.js'
import { TxRelay } from './lib/tx-relay.js'
import { DataRelay } from './lib/data-relay.js'
import { StatusServer } from './lib/status-server.js'
// network.js import removed — register/deregister now use local UTXOs + P2P broadcast

const command = process.argv[2]

/**
 * Scan historical beacon registrations on startup.
 * Fetches beacon address history from WhatsOnChain and parses each tx
 * to populate the registeredPubkeys Set with all valid registrations.
 *
 * @param {Set<string>} registeredPubkeys - Set to populate with registered pubkeys
 * @param {string} selfPubkey - Our own pubkey (skip self-registration)
 */
async function backfillBeaconRegistry (registeredPubkeys, selfPubkey) {
  const { BEACON_ADDRESS, PROTOCOL_PREFIX } = await import('@relay-federation/common/protocol')
  const { extractOpReturnData, decodePayload } = await import('@relay-federation/registry/lib/cbor.js')
  const { Transaction } = await import('@bsv/sdk')

  console.log(`  Beacon backfill: scanning ${BEACON_ADDRESS}...`)

  try {
    // Fetch confirmed history (registrations should be confirmed)
    const historyResp = await fetch(
      `https://api.whatsonchain.com/v1/bsv/main/address/${BEACON_ADDRESS}/confirmed/history`,
      { signal: AbortSignal.timeout(30000) }
    )
    if (!historyResp.ok) {
      console.log(`  Beacon backfill: WoC returned ${historyResp.status}, skipping`)
      return
    }

    const data = await historyResp.json()
    const history = Array.isArray(data) ? data : (data.result || [])
    if (history.length === 0) {
      console.log(`  Beacon backfill: no history found`)
      return
    }

    console.log(`  Beacon backfill: found ${history.length} transactions`)

    // Track registrations and deregistrations to handle order correctly
    // Process oldest first (history is typically newest-first from WoC)
    const sortedHistory = [...history].sort((a, b) => (a.height || 0) - (b.height || 0))

    let registered = 0
    let deregistered = 0
    let skipped = 0

    for (const item of sortedHistory) {
      const txid = item.tx_hash
      if (!txid) continue

      try {
        // Rate limit to avoid WoC throttling
        await new Promise(r => setTimeout(r, 100))

        const txResp = await fetch(
          `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`,
          { signal: AbortSignal.timeout(10000) }
        )
        if (!txResp.ok) {
          skipped++
          continue
        }

        const rawHex = await txResp.text()
        const tx = Transaction.fromHex(rawHex)

        // Find OP_RETURN output
        const opReturnOutput = tx.outputs.find(out =>
          out.satoshis === 0 && out.lockingScript.toHex().startsWith('006a')
        )
        if (!opReturnOutput) {
          skipped++
          continue
        }

        const { prefix, cborBytes } = extractOpReturnData(opReturnOutput.lockingScript)
        if (prefix !== PROTOCOL_PREFIX) {
          skipped++
          continue
        }

        const entry = decodePayload(cborBytes)
        if (!entry || !entry.pubkey) {
          skipped++
          continue
        }

        const pubHex = Buffer.from(entry.pubkey).toString('hex')
        if (pubHex === selfPubkey) continue // skip self

        if (entry.action === 'register') {
          registeredPubkeys.add(pubHex)
          registered++
        } else if (entry.action === 'deregister') {
          registeredPubkeys.delete(pubHex)
          deregistered++
        }
      } catch {
        skipped++
      }
    }

    console.log(`  Beacon backfill: +${registered} registered, -${deregistered} deregistered, ${skipped} skipped`)
    console.log(`  Registry: ${registeredPubkeys.size} trusted pubkeys after backfill`)
  } catch (err) {
    console.log(`  Beacon backfill failed: ${err.message}`)
  }
}

/**
 * Discover registered bridges from the overlay directory on startup.
 * Queries the overlay for this bridge's specific mesh topic and populates
 * both the trust set (registeredPubkeys) and the seed peers list.
 *
 * Only discovers peers registered to the same meshId — prevents cross-mesh peering.
 *
 * @param {Set<string>} registeredPubkeys - Set to populate with trusted pubkeys
 * @param {string} selfPubkey - Our own pubkey (skip self)
 * @param {string} meshId - This bridge's mesh identifier
 * @param {string} [overlayUrl] - Overlay node URL
 * @returns {Promise<Array<{pubkeyHex: string, endpoint: string}>>} - discovered peers with dialable endpoints
 */
async function discoverFromOverlay (registeredPubkeys, selfPubkey, meshId, overlayUrl) {
  const url = overlayUrl || 'http://127.0.0.1:3360'
  const topic = `mesh:bridge:${meshId}`
  const discoveredPeers = []

  try {
    const { DirectoryClient } = await import('@relay-federation/overlay/client')
    const client = new DirectoryClient(url, { timeoutMs: 10000 })

    const entries = await client.findByTopic(topic)

    if (!entries || entries.length === 0) {
      console.log(`  Overlay discovery: no entries for ${topic}`)
      return discoveredPeers
    }

    for (const entry of entries) {
      if (!entry.identityPubHex || entry.identityPubHex === selfPubkey) continue
      registeredPubkeys.add(entry.identityPubHex)

      // domain field contains the full WebSocket endpoint for mesh:bridge: tokens
      if (entry.domain) {
        discoveredPeers.push({
          pubkeyHex: entry.identityPubHex,
          endpoint: entry.domain
        })
      }
    }

    console.log(`  Overlay discovery: +${discoveredPeers.length} peers for ${topic}`)
    console.log(`  Registry: ${registeredPubkeys.size} trusted pubkeys after overlay discovery`)
  } catch (err) {
    console.log(`  Overlay discovery: unavailable (${err.message}) — using beacon only`)
  }

  return discoveredPeers
}

switch (command) {
  case 'init':
    await cmdInit()
    break
  case 'register':
    await cmdRegister()
    break
  case 'start':
    await cmdStart()
    break
  case 'status':
    await cmdStatus()
    break
  case 'fund':
    await cmdFund()
    break
  case 'deregister':
    await cmdDeregister()
    break
  case 'secret':
    await cmdSecret()
    break
  case 'backfill':
    await cmdBackfill()
    break
  default:
    console.log('relay-bridge — Federated SPV relay mesh bridge\n')
    console.log('Commands:')
    console.log('  init        Generate bridge identity and config')
    console.log('  register    Register this bridge via SHIP token on the overlay')
    console.log('  start       Start the bridge server')
    console.log('  status      Show running bridge status')
    console.log('  fund        Import a funding transaction (raw hex)')
    console.log('  deregister  Deregister this bridge (revoke SHIP token)')
    console.log('  secret      Show your operator secret for dashboard login')
    console.log('  backfill    Scan historical blocks for inscriptions/tokens')
    console.log('')
    console.log('Usage: relay-bridge <command> [options]')
    process.exit(command ? 1 : 0)
}

async function cmdInit () {
  const dir = defaultConfigDir()

  if (await configExists(dir)) {
    console.log(`Config already exists at ${dir}/config.json`)
    console.log('To re-initialize, delete the existing config first.')
    process.exit(1)
  }

  const config = await initConfig(dir)

  console.log('Bridge initialized!\n')
  console.log(`  Name:     ${config.name}`)
  console.log(`  Config:   ${dir}/config.json`)
  console.log(`  Endpoint: ${config.endpoint}`)
  console.log(`  Pubkey:   ${config.pubkeyHex}`)
  console.log(`  Address:  ${config.address}`)
  console.log(`  Secret:   ${config.statusSecret}`)
  console.log('')
  console.log('  Save your operator secret! You need it to log into the dashboard.')
  console.log('')
  console.log('Next steps:')
  console.log(`  1. Fund your bridge: send BSV to ${config.address}`)
  console.log('  2. Import the funding tx: relay-bridge fund <rawTxHex>')
  console.log('  3. Register via overlay: relay-bridge register')
  console.log('')
  console.log('Optional: set "overlayUrl" in config.json if your overlay')
  console.log('node is not at the default http://127.0.0.1:3360')
}

async function cmdSecret () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)

  if (!config.statusSecret) {
    console.log('No operator secret found in config.')
    console.log('Add "statusSecret" to your config.json or re-initialize.')
    process.exit(1)
  }

  console.log(`Operator secret: ${config.statusSecret}`)
  console.log('')
  console.log('Use this to log into the dashboard operator panel.')
}

async function cmdBackfill () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)
  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { parseTx } = await import('./lib/output-parser.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  // Parse CLI args: --from=HEIGHT --to=HEIGHT
  const args = {}
  for (const arg of process.argv.slice(3)) {
    const [k, v] = arg.replace(/^--/, '').split('=')
    if (k && v) args[k] = v
  }

  const fromHeight = parseInt(args.from || '800000', 10)
  const toHeight = args.to === 'latest' || !args.to ? null : parseInt(args.to, 10)
  const resumeHeight = await store.getMeta('backfill_height', null)
  const startHeight = resumeHeight ? resumeHeight + 1 : fromHeight

  console.log(`Backfill: scanning from block ${startHeight}${toHeight ? ' to ' + toHeight : ' to tip'}`)
  if (resumeHeight) console.log(`  Resuming from height ${resumeHeight + 1}`)

  let indexed = 0
  let blocksScanned = 0
  let height = startHeight

  try {
    while (true) {
      // Get block hash for this height
      const hashResp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/block/height/${height}`)
      if (!hashResp.ok) {
        if (hashResp.status === 404) {
          console.log(`  Height ${height} not found — reached chain tip`)
          break
        }
        console.log(`  WoC error at height ${height}: ${hashResp.status}, retrying in 5s...`)
        await new Promise(r => setTimeout(r, 5000))
        continue
      }
      const blockInfo = await hashResp.json()
      const blockHash = blockInfo.hash || blockInfo
      const blockTime = blockInfo.time || 0

      // Get block txid list
      await new Promise(r => setTimeout(r, 350)) // rate limit
      const txListResp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/block/${blockHash}/page/1`)
      if (!txListResp.ok) {
        console.log(`  Failed to get tx list for block ${height}, skipping`)
        height++
        continue
      }
      const txids = await txListResp.json()

      // For each txid, check if already applied, then fetch + parse
      for (const txid of txids) {
        // Idempotency: skip if already processed
        const applied = await store.getMeta(`applied!${txid}`, null)
        if (applied) continue

        // Check if we already have this tx
        let rawHex = await store.getTx(txid)
        if (!rawHex) {
          await new Promise(r => setTimeout(r, 350)) // rate limit
          const txResp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`)
          if (!txResp.ok) continue
          rawHex = await txResp.text()
          await store.putTx(txid, rawHex)
        }

        // Parse and check for inscriptions/BSV-20
        const parsed = parseTx(rawHex)
        let hasInterest = false

        for (const output of parsed.outputs) {
          if (output.type === 'ordinal' && output.parsed) {
            await store.putInscription({
              txid,
              vout: output.vout,
              contentType: output.parsed.contentType || null,
              contentSize: output.parsed.content ? output.parsed.content.length / 2 : 0,
              content: output.parsed.content || null,
              isBsv20: output.parsed.isBsv20 || false,
              bsv20: output.parsed.bsv20 || null,
              timestamp: (blockTime || 0) * 1000,
              address: output.hash160 || null
            })
            indexed++
            hasInterest = true
          }
        }

        // Mark tx as confirmed (trusting WoC block placement)
        await store.updateTxStatus(txid, 'confirmed', { blockHash, height, source: 'backfill' })
        await store.putMeta(`applied!${txid}`, { height, blockHash })
      }

      await store.putMeta('backfill_height', height)
      blocksScanned++

      if (blocksScanned % 100 === 0) {
        console.log(`  Block ${height} — ${blocksScanned} scanned, ${indexed} inscriptions indexed`)
      }

      if (toHeight && height >= toHeight) break
      height++
    }
  } catch (err) {
    console.log(`  Backfill error at height ${height}: ${err.message}`)
    console.log(`  Progress saved — resume with: relay-bridge backfill`)
  } finally {
    await store.close()
  }

  console.log(`Backfill complete: ${blocksScanned} blocks scanned, ${indexed} inscriptions indexed`)
}

async function cmdRegister () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)

  if (config.endpoint === 'wss://your-bridge.example.com:8333') {
    console.log('Error: Update your endpoint in config.json before registering.')
    process.exit(1)
  }

  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { runOverlayRegister } = await import('./lib/actions.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  console.log('Registration details:\n')

  try {
    const result = await runOverlayRegister({
      config,
      store,
      overlayUrl: config.overlayUrl,
      log: (type, msg) => console.log(type === 'done' ? msg : `  ${msg}`)
    })
    console.log('')
    console.log('Your bridge is now registered via SHIP token on the overlay.')
  } catch (err) {
    console.log(`Registration failed: ${err.message}`)
    await store.close()
    process.exit(1)
  }

  await store.close()
}

async function cmdStart () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)
  const rawPeerArg = process.argv[3] // optional: ws://host:port
  const peerArg = (rawPeerArg && !rawPeerArg.startsWith('-')) ? rawPeerArg : null

  // ── 1. Open persistent store ──────────────────────────────
  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { PrivateKey } = await import('@bsv/sdk')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()
  console.log(`Database opened: ${dataDir}`)

  // Load persisted balance
  const balance = await store.getBalance()
  if (balance > 0) {
    console.log(`  Wallet balance: ${balance} satoshis`)
  }

  // ── 2. Core components ────────────────────────────────────
  const peerManager = new PeerManager()
  const headerRelay = new HeaderRelay(peerManager)
  const txRelay = new TxRelay(peerManager)
  const dataRelay = new DataRelay(peerManager)

  // ── 2b. Phase 2: Security layer ────────────────────────────
  const { PeerScorer } = await import('./lib/peer-scorer.js')
  const { ScoreActions } = await import('./lib/score-actions.js')
  const { DataValidator } = await import('./lib/data-validator.js')
  const { PeerHealth } = await import('./lib/peer-health.js')
  const { AnchorManager } = await import('./lib/anchor-manager.js')
  const { createHandshake } = await import('./lib/handshake.js')

  const scorer = new PeerScorer()
  const scoreActions = new ScoreActions(scorer, peerManager)
  const dataValidator = new DataValidator(peerManager, scorer)
  const peerHealth = new PeerHealth()
  const anchorManager = new AnchorManager(peerManager, {
    anchors: config.anchorBridges || []
  })

  const handshake = createHandshake({
    wif: config.wif,
    pubkeyHex: config.pubkeyHex,
    endpoint: config.endpoint
  })

  // Wire peer health tracking
  peerManager.on('peer:connect', ({ pubkeyHex, endpoint }) => {
    peerHealth.recordSeen(pubkeyHex)
    scorer.setStakeAge(pubkeyHex, 7)
    if (endpoint) {
      const updated = gossipManager.updatePeerEndpoint({ pubkeyHex, endpoint, meshId: config.meshId })
      if (updated) {
        console.log(`  Endpoint updated: ${pubkeyHex.slice(0, 16)}... → ${endpoint}`)
      }
    }
  })

  peerManager.on('peer:disconnect', ({ pubkeyHex }) => {
    peerHealth.recordOffline(pubkeyHex)
  })

  // Wire peer:message → health.recordSeen (any message = peer is alive)
  peerManager.on('peer:message', ({ pubkeyHex }) => {
    peerHealth.recordSeen(pubkeyHex)
  })

  // Ping infrastructure — 60s interval, measures latency for scoring
  const PING_INTERVAL_MS = 60000
  const pendingPings = new Map() // pubkeyHex → timestamp

  peerManager.on('peer:message', ({ pubkeyHex, message }) => {
    if (message.type === 'ping') {
      // Respond with pong
      const conn = peerManager.peers.get(pubkeyHex)
      if (conn) conn.send({ type: 'pong', nonce: message.nonce })
    } else if (message.type === 'pong') {
      // Record latency
      const sentAt = pendingPings.get(pubkeyHex)
      if (sentAt) {
        const latency = Date.now() - sentAt
        pendingPings.delete(pubkeyHex)
        if (!peerHealth.isInGracePeriod(pubkeyHex)) {
          scorer.recordPing(pubkeyHex, latency)
        }
      }
    }
  })

  const pingTimer = setInterval(() => {
    const nonce = Date.now().toString(36)
    for (const [pubkeyHex, conn] of peerManager.peers) {
      if (conn.connected) {
        // Check for timed-out previous pings
        if (pendingPings.has(pubkeyHex)) {
          if (!peerHealth.isInGracePeriod(pubkeyHex)) {
            scorer.recordPingTimeout(pubkeyHex)
          }
          pendingPings.delete(pubkeyHex)
        }
        pendingPings.set(pubkeyHex, Date.now())
        conn.send({ type: 'ping', nonce })
      }
    }
  }, PING_INTERVAL_MS)
  if (pingTimer.unref) pingTimer.unref()

  // Health check — every 10 minutes, detect inactive peers
  const HEALTH_CHECK_INTERVAL_MS = 10 * 60 * 1000
  const healthTimer = setInterval(() => {
    const { grace, inactive } = peerHealth.checkAll()
    for (const pk of inactive) {
      console.log(`Peer inactive (7d+): ${pk.slice(0, 16)}...`)
    }
  }, HEALTH_CHECK_INTERVAL_MS)
  if (healthTimer.unref) healthTimer.unref()

  // Start anchor monitoring
  anchorManager.startMonitoring()

  console.log(`  Security: scoring, validation, health, anchors active`)

  // ── 3. Address watcher — watch our own address + beacon ──
  const { AddressWatcher } = await import('./lib/address-watcher.js')
  const { addressToHash160 } = await import('./lib/output-parser.js')
  const { BEACON_ADDRESS } = await import('@relay-federation/common/protocol')
  const watcher = new AddressWatcher(txRelay, store)
  watcher.watchPubkey(config.pubkeyHex, 'self')
  const beaconHash160 = addressToHash160(BEACON_ADDRESS)
  watcher.watchHash160(beaconHash160, 'beacon')
  console.log(`  Watching own address + beacon (${BEACON_ADDRESS})`)

  // ── 4. Gossip manager — P2P peer discovery ────────────────
  const { GossipManager } = await import('./lib/gossip.js')
  const privKey = PrivateKey.fromWif(config.wif)
  const gossipManager = new GossipManager(peerManager, {
    privKey,
    pubkeyHex: config.pubkeyHex,
    endpoint: config.endpoint,
    meshId: config.meshId
  })

  // Add seed peers to gossip directory
  const seedPeers = config.seedPeers || []
  for (const seed of seedPeers) {
    gossipManager.addSeed(seed)
  }

  // ── 4a. Registry — track registered pubkeys for handshake gating ──
  const registeredPubkeys = new Set()
  registeredPubkeys.add(config.pubkeyHex) // always trust self
  const seedEndpoints = new Set()
  for (const seed of seedPeers) {
    if (seed.pubkeyHex) registeredPubkeys.add(seed.pubkeyHex)
    const ep = typeof seed === 'string' ? seed : seed.endpoint
    if (ep) seedEndpoints.add(ep)
  }
  console.log(`  Registry: ${registeredPubkeys.size} trusted pubkeys (self + seeds)`)

  // ── 4a-2. Beacon backfill — scan historical registrations on startup ──
  await backfillBeaconRegistry(registeredPubkeys, config.pubkeyHex)

  // ── 4a-3. Overlay discovery — query overlay for registered bridges ──
  const overlayPeers = await discoverFromOverlay(registeredPubkeys, config.pubkeyHex, config.meshId, config.overlayUrl)
  for (const peer of overlayPeers) {
    if (peer.endpoint) {
      seedEndpoints.add(peer.endpoint)
      // Add to seedPeers for outbound dialing (avoid duplicates)
      const alreadySeeded = seedPeers.some(s =>
        (typeof s === 'string' ? s : s.endpoint) === peer.endpoint
      )
      if (!alreadySeeded) {
        seedPeers.push({ pubkeyHex: peer.pubkeyHex, endpoint: peer.endpoint })
      }
    }
  }

  // ── 4b. Beacon address watcher — detect on-chain registrations ──
  const { extractOpReturnData, decodePayload, PROTOCOL_PREFIX } = await import('@relay-federation/registry/lib/cbor.js')
  const { Transaction: BsvTx } = await import('@bsv/sdk')

  // Registry bootstrapped via discoverNewPeers() after server start (no WoC dependency)

  watcher.on('utxo:received', async ({ txid, hash160 }) => {
    if (hash160 !== beaconHash160) return

    try {
      const rawHex = await store.getTx(txid)
      if (!rawHex) return

      const tx = BsvTx.fromHex(rawHex)
      const opReturnOutput = tx.outputs.find(out =>
        out.satoshis === 0 && out.lockingScript.toHex().startsWith('006a')
      )
      if (!opReturnOutput) return

      const { prefix, cborBytes } = extractOpReturnData(opReturnOutput.lockingScript)
      if (prefix !== PROTOCOL_PREFIX) return

      const entry = decodePayload(cborBytes)

      if (entry.action === 'register') {
        const pubHex = Buffer.from(entry.pubkey).toString('hex')
        if (pubHex === config.pubkeyHex) return // skip self

        registeredPubkeys.add(pubHex)
        gossipManager.addSeed({
          pubkeyHex: pubHex,
          endpoint: entry.endpoint,
          meshId: entry.mesh_id
        })
        console.log(`Beacon: new registration detected — ${pubHex.slice(0, 16)}... @ ${entry.endpoint}`)
        const stakeAgeDays = Math.max(0, (Date.now() / 1000 - entry.timestamp) / 86400)
        scorer.setStakeAge(pubHex, stakeAgeDays)
      } else if (entry.action === 'deregister') {
        const pubHex = Buffer.from(entry.pubkey).toString('hex')
        registeredPubkeys.delete(pubHex)
        console.log(`Beacon: deregistration detected — ${pubHex.slice(0, 16)}...`)
      }
    } catch {
      // Skip unparseable beacon txs
    }
  })


  // ── Outbound handshake helper ──────────────────────────────
  function performOutboundHandshake (conn) {
    const { message: helloMsg, nonce } = handshake.createHello()
    conn.send(helloMsg)

    const onMessage = (msg) => {
      if (msg.type === 'challenge_response') {
        conn.removeListener('message', onMessage)
        clearTimeout(timeout)
        const result = handshake.handleChallengeResponse(msg, nonce, conn.isSeed ? null : registeredPubkeys)
        if (result.error) {
          console.log(`Handshake failed with ${conn.pubkeyHex.slice(0, 16)}...: ${result.error}`)
          conn.destroy()
          return
        }
        // Re-key if we didn't know their real pubkey
        if (result.peerPubkey !== conn.pubkeyHex) {
          peerManager.peers.delete(conn.pubkeyHex)
          conn.pubkeyHex = result.peerPubkey
        }

        // Tie-break duplicate connections (inbound may have been accepted during handshake)
        const existing = peerManager.peers.get(result.peerPubkey)
        if (existing && existing !== conn) {
          // If existing connection is dead, prefer new working connection
          if (!existing.connected) {
            console.log(`  Replacing dead connection to ${result.peerPubkey.slice(0, 16)}...`)
            existing._shouldReconnect = false
            existing.destroy()
          } else if (config.pubkeyHex > result.peerPubkey) {
            // Higher pubkey drops outbound — keep existing inbound
            console.log(`  Duplicate: keeping inbound from ${result.peerPubkey.slice(0, 16)}...`)
            conn._shouldReconnect = false
            conn.destroy()
            return
          } else {
            // Lower pubkey keeps outbound — drop existing inbound
            console.log(`  Duplicate: keeping outbound to ${result.peerPubkey.slice(0, 16)}...`)
            existing._shouldReconnect = false
            existing.destroy()
          }
        }

        peerManager.peers.set(result.peerPubkey, conn)
        // Learn seed pubkeys so future inbound connections from them pass registry check
        if (conn.isSeed && !registeredPubkeys.has(result.peerPubkey)) {
          registeredPubkeys.add(result.peerPubkey)
          console.log(`  Seed pubkey learned: ${result.peerPubkey.slice(0, 16)}...`)
        }
        console.log(`  Peer identified: ${result.peerPubkey.slice(0, 16)}... (v${result.selectedVersion})`)

        // Send verify to complete handshake
        conn.send(result.message)
        // Handshake complete — now safe to announce peer:connect
        peerManager.emit('peer:connect', { pubkeyHex: conn.pubkeyHex, endpoint: conn.endpoint })
      }
    }
    conn.on('message', onMessage)

    // Timeout: if no challenge_response within 10s, drop
    const timeout = setTimeout(() => {
      conn.removeListener('message', onMessage)
      if (!conn.connected) return
      console.log(`Handshake timeout: ${conn.pubkeyHex.slice(0, 16)}...`)
      conn.destroy()
    }, 10000)
    if (timeout.unref) timeout.unref()

    // Clean up on close — prevent stale handler on reconnect
    conn.once('close', () => {
      clearTimeout(timeout)
      conn.removeListener('message', onMessage)
    })
  }

  // ── 5. Start server ───────────────────────────────────────
  await peerManager.startServer({ port: config.port, host: '0.0.0.0', pubkeyHex: config.pubkeyHex, endpoint: config.endpoint, handshake, registeredPubkeys, seedEndpoints })
  console.log(`Bridge listening on port ${config.port}`)
  console.log(`  Pubkey: ${config.pubkeyHex}`)
  console.log(`  Mesh:   ${config.meshId}`)

  // ── 6. Persistence layer — save headers/txs to LevelDB ───
  headerRelay.on('header:new', async (header) => {
    try { await store.putHeader(header) } catch {}
  })

  headerRelay.on('header:sync', async ({ headers }) => {
    if (headers && headers.length) {
      try { await store.putHeaders(headers) } catch {}
    }
  })

  txRelay.on('tx:new', async ({ txid, rawHex }) => {
    try { await store.putTx(txid, rawHex) } catch {}
    try { await store.updateTxStatus(txid, 'mempool', { source: 'p2p' }) } catch {}
    // Index inscriptions
    try {
      const { parseTx } = await import('./lib/output-parser.js')
      const parsed = parseTx(rawHex)
      for (const output of parsed.outputs) {
        if (output.type === 'ordinal' && output.parsed) {
          await store.putInscription({
            txid,
            vout: output.vout,
            contentType: output.parsed.contentType || null,
            contentSize: output.parsed.content ? output.parsed.content.length / 2 : 0,
            isBsv20: output.parsed.isBsv20 || false,
            bsv20: output.parsed.bsv20 || null,
            timestamp: Date.now(),
            address: output.hash160 || null
          })
        }
      }
    } catch {}
  })

  // ── 6b. BSV P2P header sync — connect to BSV nodes ──────
  const { BSVNodeClient } = await import('./lib/bsv-node-client.js')
  const bsvNode = new BSVNodeClient()

  bsvNode.on('headers', async ({ headers, count }) => {
    // Feed into HeaderRelay for peer propagation
    const added = headerRelay.addHeaders(headers)
    if (added > 0) {
      console.log(`BSV P2P: synced ${added} headers (height: ${headerRelay.bestHeight})`)
      // Persist to LevelDB
      try { await store.putHeaders(headers) } catch {}
      // Announce to federation peers
      headerRelay.announceToAll()
    }
  })

  bsvNode.on('connected', ({ host }) => {
    console.log(`BSV P2P: connected to ${host}:8333`)
  })

  bsvNode.on('handshake', ({ userAgent, startHeight }) => {
    console.log(`BSV P2P: handshake complete (${userAgent}, height: ${startHeight})`)
  })

  bsvNode.on('disconnected', () => {
    console.log('BSV P2P: disconnected, will reconnect...')
  })

  bsvNode.on('error', (err) => {
    // Don't crash — just log
    if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT') {
      console.log(`BSV P2P: ${err.message}`)
    }
  })

  // Auto-detect incoming payments: request txs announced via INV
  bsvNode.on('tx:inv', ({ txids }) => {
    for (const txid of txids) {
      if (txRelay.seen.has(txid)) continue
      bsvNode.getTx(txid, 10000).then(({ txid: id, rawHex }) => {
        txRelay.broadcastTx(id, rawHex)
      }).catch(() => {}) // ignore fetch failures
    }
  })

  // Feed raw txs from BSV P2P into the mesh relay + address watcher
  bsvNode.on('tx', ({ txid, rawHex }) => {
    if (!txRelay.seen.has(txid)) {
      txRelay.broadcastTx(txid, rawHex)
    }
  })

  // Start the BSV P2P connection
  bsvNode.connect()

  // ── 7. Connect to peers ───────────────────────────────────
  let gossipStarted = false

  // Start gossip after first peer connection completes.
  // Delay 5s so all seed handshakes finish before gossip broadcasts
  // (immediate broadcast would send announce/getpeers through connections
  // whose inbound side is still waiting for verify — breaking the handshake).
  peerManager.on('peer:connect', () => {
    if (!gossipStarted) {
      gossipStarted = true
      setTimeout(() => {
        gossipManager.start()
        gossipManager.requestPeersFromAll()
        console.log('Gossip started')
      }, 5000)

      // Periodic peer refresh — re-request peer lists every 10 minutes
      // Catches registrations missed during downtime or initial gossip
      const PEER_REFRESH_MS = 10 * 60 * 1000
      const refreshTimer = setInterval(() => {
        gossipManager.requestPeersFromAll()
      }, PEER_REFRESH_MS)
      if (refreshTimer.unref) refreshTimer.unref()
    }
  })

  // Auto-connect to newly discovered peers (with reachability probe + IP diversity)
  const { probeEndpoint } = await import('./lib/endpoint-probe.js')
  const { checkIpDiversity } = await import('./lib/ip-diversity.js')

  gossipManager.on('peer:discovered', async ({ pubkeyHex, endpoint }) => {
    if (peerManager.peers.has(pubkeyHex) || pubkeyHex === config.pubkeyHex) return

    // IP diversity check — prevent all peers clustering in one datacenter
    const connectedEndpoints = [...peerManager.peers.values()]
      .filter(c => c.endpoint).map(c => c.endpoint)
    const diversity = checkIpDiversity(connectedEndpoints, endpoint)
    if (!diversity.allowed) {
      console.log(`IP diversity blocked: ${pubkeyHex.slice(0, 16)}... — ${diversity.reason}`)
      return
    }

    const reachable = await probeEndpoint(endpoint)
    if (!reachable) {
      console.log(`Probe failed: ${pubkeyHex.slice(0, 16)}... ${endpoint} — skipping`)
      return
    }

    console.log(`Discovered peer via gossip: ${pubkeyHex.slice(0, 16)}... ${endpoint}`)
    const conn = peerManager.connectToPeer({ pubkeyHex, endpoint })
    if (conn) {
      conn.on('open', () => performOutboundHandshake(conn))
    }
  })

  if (peerArg) {
    // Manual peer connection
    console.log(`Connecting to peer: ${peerArg}`)
    const conn = peerManager.connectToPeer({
      pubkeyHex: 'manual_peer',
      endpoint: peerArg
    })
    if (conn) {
      conn.on('open', () => performOutboundHandshake(conn))
    }
  } else if (seedPeers.length > 0) {
    // Connect to seed peers (accept both string URLs and {pubkeyHex, endpoint} objects)
    console.log(`Connecting to ${seedPeers.length} seed peer(s)...`)
    for (let i = 0; i < seedPeers.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000)) // stagger to avoid handshake races
      const seed = seedPeers[i]
      const endpoint = typeof seed === 'string' ? seed : seed.endpoint
      const pubkey = typeof seed === 'string' ? `seed_${i}` : seed.pubkeyHex
      const conn = peerManager.connectToPeer({ pubkeyHex: pubkey, endpoint })
      if (conn) {
        conn.isSeed = true
        conn.on('open', () => performOutboundHandshake(conn))
      }
    }
  } else if (config.apiKey) {
    // Fallback: scan chain for peers (legacy mode)
    console.log('No seed peers configured. Scanning chain for peers...')
    try {
      const { scanRegistry } = await import('@relay-federation/registry/lib/scanner.js')
      const { buildPeerList, excludeSelf } = await import('@relay-federation/registry/lib/discovery.js')
      const { savePeerCache, loadPeerCache } = await import('@relay-federation/registry/lib/peer-cache.js')

      const cachePath = join(dir, 'cache', 'peers.json')
      let peers = await loadPeerCache(cachePath)

      if (!peers) {
        const entries = await scanRegistry({
          spvEndpoint: config.spvEndpoint,
          apiKey: config.apiKey
        })
        peers = buildPeerList(entries)
        peers = excludeSelf(peers, config.pubkeyHex)
        await savePeerCache(peers, cachePath)
      }

      console.log(`Found ${peers.length} peers`)
      for (const peer of peers) {
        const conn = peerManager.connectToPeer(peer)
        if (conn) {
          conn.on('open', () => performOutboundHandshake(conn))
        }
      }
    } catch (err) {
      console.log(`Peer scan failed: ${err.message}`)
      console.log('Start with manual peer: relay-bridge start ws://peer:port')
    }
  } else {
    console.log('No seed peers, no manual peer, and no API key configured.')
    console.log('Usage: relay-bridge start ws://peer:port')
    console.log('   or: Add seedPeers to config.json')
  }

  // ── 8. Status server ──────────────────────────────────────
  const statusPort = config.statusPort || 9333
  const statusServer = new StatusServer({
    port: statusPort,
    peerManager,
    headerRelay,
    txRelay,
    dataRelay,
    config,
    scorer,
    peerHealth,
    bsvNodeClient: bsvNode,
    store,
    performOutboundHandshake,
    registeredPubkeys,
    gossipManager
  })
  await statusServer.start()
  statusServer.startAppMonitoring()
  console.log(`  Status: http://127.0.0.1:${statusPort}/status`)

  // ── Peer discovery — bootstrap registry from seed peers, then periodic refresh ──
  const knownEndpoints = new Set()
  for (const sp of (config.seedPeers || [])) knownEndpoints.add(sp.endpoint)
  knownEndpoints.add(config.endpoint)

  async function discoverNewPeers () {
    const peersToQuery = [...(config.seedPeers || [])]
    for (const [, conn] of peerManager.peers) {
      if (conn.endpoint && conn.readyState === 1) peersToQuery.push({ endpoint: conn.endpoint })
    }
    for (const peer of peersToQuery) {
      try {
        const ep = peer.endpoint || ''
        const u = new URL(ep)
        const statusUrl = 'http://' + u.hostname + ':' + (parseInt(u.port, 10) + 1000) + '/discover'
        const res = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) continue
        const data = await res.json()
        if (!data.bridges) continue
        for (const b of data.bridges) {
          if (!b.endpoint) continue
          if (b.pubkeyHex) registeredPubkeys.add(b.pubkeyHex)
          seedEndpoints.add(b.endpoint)
          if (knownEndpoints.has(b.endpoint)) continue
          knownEndpoints.add(b.endpoint)
          const conn = peerManager.connectToPeer({ endpoint: b.endpoint, pubkeyHex: b.pubkeyHex })
          if (conn) {
            conn.on('open', () => performOutboundHandshake(conn))
            const msg = `Discovered new peer: ${b.name || b.pubkeyHex?.slice(0, 16) || b.endpoint}`
            console.log(msg)
            statusServer.addLog(msg)
          }
        }
      } catch {}
    }
  }
  await discoverNewPeers()
  console.log(`  Registry: ${registeredPubkeys.size} trusted pubkeys after peer discovery`)
  setTimeout(discoverNewPeers, 5000)
  setInterval(discoverNewPeers, 300000)

  // ── 9. Log events (dual: console + status server ring buffer) ──
  peerManager.on('peer:connect', ({ pubkeyHex }) => {
    const msg = `Peer connected: ${pubkeyHex.slice(0, 16)}...`
    console.log(msg)
    statusServer.addLog(msg)
  })

  peerManager.on('peer:disconnect', ({ pubkeyHex }) => {
    const msg = `Peer disconnected: ${pubkeyHex ? pubkeyHex.slice(0, 16) + '...' : 'unknown'}`
    console.log(msg)
    statusServer.addLog(msg)
  })

  headerRelay.on('header:sync', ({ pubkeyHex, added, bestHeight }) => {
    const msg = `Synced ${added} headers from ${pubkeyHex.slice(0, 16)}... (height: ${bestHeight})`
    console.log(msg)
    statusServer.addLog(msg)
  })

  txRelay.on('tx:new', ({ txid }) => {
    const msg = `New tx: ${txid}`
    console.log(msg)
    statusServer.addLog(msg)
  })

  dataRelay.on('data:new', ({ topic, pubkeyHex }) => {
    const msg = `Data envelope: ${topic} from ${pubkeyHex.slice(0, 16)}...`
    console.log(msg)
    statusServer.addLog(msg)
  })

  watcher.on('utxo:received', ({ txid, vout, satoshis }) => {
    const msg = `UTXO received: ${txid}:${vout} (${satoshis} sat)`
    console.log(msg)
    statusServer.addLog(msg)
  })

  watcher.on('utxo:spent', ({ txid, vout, spentByTxid }) => {
    const msg = `UTXO spent: ${txid.slice(0, 16)}...:${vout} by ${spentByTxid.slice(0, 16)}...`
    console.log(msg)
    statusServer.addLog(msg)
  })

  // Phase 2 events
  scoreActions.on('peer:disconnected', ({ pubkeyHex, score }) => {
    console.log(`Score disconnect: ${pubkeyHex.slice(0, 16)}... (score: ${score.toFixed(2)})`)
  })

  scoreActions.on('peer:blacklisted', ({ pubkeyHex, score }) => {
    console.log(`Blacklisted: ${pubkeyHex.slice(0, 16)}... (score: ${score.toFixed(2)}, 24h)`)
  })

  dataValidator.on('validation:fail', ({ pubkeyHex, type, reason }) => {
    console.log(`Bad data from ${pubkeyHex.slice(0, 16)}...: ${type} — ${reason}`)
  })

  anchorManager.on('anchor:disconnect', ({ pubkeyHex }) => {
    console.log(`Anchor disconnected: ${pubkeyHex.slice(0, 16)}...`)
  })

  anchorManager.on('anchor:low_score', ({ pubkeyHex, score }) => {
    console.log(`Anchor low score: ${pubkeyHex.slice(0, 16)}... (${score.toFixed(2)})`)
  })

  peerHealth.on('peer:recovered', ({ pubkeyHex }) => {
    console.log(`Peer recovered: ${pubkeyHex.slice(0, 16)}...`)
  })

  // ── 10. Graceful shutdown ─────────────────────────────────
  const shutdown = async () => {
    console.log('\nShutting down...')
    clearInterval(pingTimer)
    clearInterval(healthTimer)
    anchorManager.stopMonitoring()
    bsvNode.disconnect()
    gossipManager.stop()
    await statusServer.stop()
    await peerManager.shutdown()
    await store.close()
    console.log('Database closed.')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function cmdStatus () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)
  const statusPort = config.statusPort || 9333

  let status
  try {
    const res = await fetch(`http://127.0.0.1:${statusPort}/status`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    status = await res.json()
  } catch {
    console.log('Bridge is not running.')
    console.log(`  (expected status server on port ${statusPort})`)
    console.log('  Start it with: relay-bridge start')
    process.exit(1)
  }

  console.log('Bridge Status\n')

  // Bridge identity
  console.log('  Bridge')
  console.log(`    Pubkey:   ${status.bridge.pubkeyHex}`)
  console.log(`    Endpoint: ${status.bridge.endpoint}`)
  console.log(`    Mesh:     ${status.bridge.meshId}`)
  console.log(`    Uptime:   ${formatUptime(status.bridge.uptimeSeconds)}`)

  // Peers
  console.log('')
  console.log(`  Peers (${status.peers.connected}/${status.peers.max})`)
  if (status.peers.list.length === 0) {
    console.log('    (no peers)')
  } else {
    for (const peer of status.peers.list) {
      const tag = peer.connected ? 'connected' : 'disconnected'
      console.log(`    ${peer.pubkeyHex.slice(0, 16)}... ${peer.endpoint} (${tag})`)
    }
  }

  // Headers
  console.log('')
  console.log('  Headers')
  console.log(`    Best Height: ${status.headers.bestHeight}`)
  console.log(`    Best Hash:   ${status.headers.bestHash || '(none)'}`)
  console.log(`    Stored:      ${status.headers.count}`)

  // Transactions
  console.log('')
  console.log('  Transactions')
  console.log(`    Mempool: ${status.txs.mempool}`)
  console.log(`    Seen:    ${status.txs.seen}`)

  // BSV Node
  if (status.bsvNode) {
    console.log('')
    console.log('  BSV Node')
    console.log(`    Status: ${status.bsvNode.connected ? 'Connected' : 'Disconnected'}`)
    console.log(`    Host:   ${status.bsvNode.host || '-'}`)
    console.log(`    Height: ${status.bsvNode.height || '-'}`)
  }

  // Wallet
  if (status.wallet) {
    console.log('')
    console.log('  Wallet')
    console.log(`    Balance: ${status.wallet.balanceSats !== null ? status.wallet.balanceSats + ' sats' : '-'}`)
  }

  // Overlay registration
  console.log('')
  console.log('  Overlay')
  const overlayUrl = config.overlayUrl || 'http://127.0.0.1:3360'
  try {
    const overlayRes = await fetch(`${overlayUrl}/status`, { signal: AbortSignal.timeout(5000) })
    if (overlayRes.ok) {
      const overlayStatus = await overlayRes.json()
      console.log(`    Directory: ${overlayUrl} (${overlayStatus.topics} topics, ${overlayStatus.entries} entries)`)
    } else {
      console.log(`    Directory: ${overlayUrl} (HTTP ${overlayRes.status})`)
    }
  } catch {
    console.log(`    Directory: ${overlayUrl} (unreachable)`)
  }

  // Check local overlay registration metadata
  try {
    const { PersistentStore } = await import('./lib/persistent-store.js')
    const dataDir = config.dataDir || join(dir, 'data')
    const store = new PersistentStore(dataDir)
    await store.open()
    const shipTxid = await store.getMeta('overlay_ship_txid')
    const overlayTopic = await store.getMeta('overlay_topic')
    if (shipTxid) {
      console.log(`    Registered: ${overlayTopic} (SHIP txid: ${shipTxid.slice(0, 16)}...)`)
    } else {
      console.log('    Registered: no (run: relay-bridge register)')
    }
    await store.close()
  } catch {
    console.log('    Registered: unknown (could not read local state)')
  }
}

async function cmdFund () {
  const rawHex = process.argv[3]
  if (!rawHex) {
    console.log('Usage: relay-bridge fund <rawTxHex>')
    console.log('')
    console.log('  Provide the raw hex of a transaction that pays to this bridge.')
    console.log('  Get the raw hex from your wallet or a block explorer after sending BSV.')
    process.exit(1)
  }

  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)
  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { runFund } = await import('./lib/actions.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  try {
    await runFund({
      config,
      store,
      rawHex,
      log: (type, msg) => console.log(`  ${msg}`)
    })
  } catch (err) {
    console.log(`Fund failed: ${err.message}`)
    process.exit(1)
  } finally {
    await store.close()
  }
}

async function cmdDeregister () {
  const dir = defaultConfigDir()

  if (!(await configExists(dir))) {
    console.log('No config found. Run: relay-bridge init')
    process.exit(1)
  }

  const config = await loadConfig(dir)

  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { runOverlayDeregister } = await import('./lib/actions.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  console.log('Deregistration:\n')

  try {
    await runOverlayDeregister({
      config,
      store,
      overlayUrl: config.overlayUrl,
      log: (type, msg) => console.log(type === 'done' ? msg : `  ${msg}`)
    })
    console.log('')
    console.log('Your SHIP token has been revoked.')
  } catch (err) {
    console.log(`Deregistration failed: ${err.message}`)
    await store.close()
    process.exit(1)
  }

  await store.close()
}

function formatUptime (seconds) {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}
