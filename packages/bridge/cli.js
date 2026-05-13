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
/**
 * Fetch beacon address history from multiple providers.
 * Tries GorillaPool first, falls back to WoC.
 * @param {string} beaconAddress
 * @returns {Promise<string[]>} Array of txids
 */
async function fetchBeaconHistory (beaconAddress) {
  // Provider 1: GorillaPool ordinals — unspent outputs at beacon address
  // Beacon outputs are unspendable (no private key), so unspent = full history
  try {
    const gpResp = await fetch(
      `https://ordinals.gorillapool.io/api/txos/address/${beaconAddress}/unspent`,
      { signal: AbortSignal.timeout(15000) }
    )
    if (gpResp.ok) {
      const gpData = await gpResp.json()
      if (Array.isArray(gpData) && gpData.length > 0) {
        console.log(`  Beacon backfill: GorillaPool returned ${gpData.length} UTXOs`)
        return gpData.map(u => u.txid).filter(Boolean)
      }
    }
  } catch {}

  // Provider 2: WoC — confirmed history (last resort)
  try {
    const wocResp = await fetch(
      `https://api.whatsonchain.com/v1/bsv/main/address/${beaconAddress}/confirmed/history`,
      { signal: AbortSignal.timeout(30000) }
    )
    if (wocResp.ok) {
      const data = await wocResp.json()
      const history = Array.isArray(data) ? data : (data.result || [])
      if (history.length > 0) {
        console.log(`  Beacon backfill: WoC returned ${history.length} transactions`)
        return history.sort((a, b) => (a.height || 0) - (b.height || 0)).map(h => h.tx_hash).filter(Boolean)
      }
    }
  } catch {}

  return []
}

/**
 * Fetch raw tx hex from available providers.
 * @param {string} txid
 * @returns {Promise<string|null>}
 */
async function fetchRawTx (txid) {
  // WoC — returns clean hex string
  try {
    const resp = await fetch(
      `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`,
      { signal: AbortSignal.timeout(10000) }
    )
    if (resp.ok) return await resp.text()
  } catch {}

  return null
}

/**
 * Scan historical beacon registrations on startup.
 * Fetches beacon address history from GorillaPool/WoC and parses each tx
 * to populate the registeredPubkeys Set with all valid registrations.
 * Returns discovered peers with endpoints for zero-config mesh bootstrap.
 *
 * @param {Set<string>} registeredPubkeys - Set to populate with registered pubkeys
 * @param {string} selfPubkey - Our own pubkey (skip self-registration)
 * @returns {Promise<Array<{pubkeyHex: string, endpoint: string}>>} Discovered peers
 */
async function backfillBeaconRegistry (registeredPubkeys, selfPubkey) {
  const { BEACON_ADDRESS, PROTOCOL_PREFIX } = await import('@relay-federation/common/protocol')
  const { extractOpReturnData, decodePayload } = await import('@relay-federation/registry/lib/cbor.js')
  const { Transaction } = await import('@bsv/sdk')

  console.log(`  Beacon backfill: scanning ${BEACON_ADDRESS}...`)
  const discoveredPeers = []

  try {
    const txids = await fetchBeaconHistory(BEACON_ADDRESS)
    if (txids.length === 0) {
      console.log(`  Beacon backfill: no history found`)
      return discoveredPeers
    }

    // Track registrations and deregistrations
    // Also track endpoints: pubkey → endpoint (latest wins)
    const peerEndpoints = new Map()
    let registered = 0
    let deregistered = 0
    let skipped = 0

    for (const txid of txids) {
      try {
        // Rate limit to avoid throttling
        await new Promise(r => setTimeout(r, 100))

        const rawHex = await fetchRawTx(txid)
        if (!rawHex) { skipped++; continue }

        const tx = Transaction.fromHex(rawHex)

        // Find OP_RETURN output
        const opReturnOutput = tx.outputs.find(out =>
          out.satoshis === 0 && out.lockingScript.toHex().startsWith('006a')
        )
        if (!opReturnOutput) { skipped++; continue }

        const { prefix, cborBytes } = extractOpReturnData(opReturnOutput.lockingScript)
        if (prefix !== PROTOCOL_PREFIX) { skipped++; continue }

        const entry = decodePayload(cborBytes)
        if (!entry || !entry.pubkey) { skipped++; continue }

        const pubHex = Buffer.from(entry.pubkey).toString('hex')
        if (pubHex === selfPubkey) continue // skip self

        if (entry.action === 'register') {
          registeredPubkeys.add(pubHex)
          if (entry.endpoint) peerEndpoints.set(pubHex, entry.endpoint)
          registered++
        } else if (entry.action === 'deregister') {
          registeredPubkeys.delete(pubHex)
          peerEndpoints.delete(pubHex)
          deregistered++
        }
      } catch {
        skipped++
      }
    }

    // Build discovered peers list from active registrations
    for (const [pubkeyHex, endpoint] of peerEndpoints) {
      if (registeredPubkeys.has(pubkeyHex)) {
        discoveredPeers.push({ pubkeyHex, endpoint })
      }
    }

    console.log(`  Beacon backfill: +${registered} registered, -${deregistered} deregistered, ${skipped} skipped`)
    console.log(`  Registry: ${registeredPubkeys.size} trusted pubkeys after backfill`)
    if (discoveredPeers.length > 0) {
      console.log(`  Discovered ${discoveredPeers.length} peer endpoint(s) from on-chain registry`)
    }
  } catch (err) {
    console.log(`  Beacon backfill failed: ${err.message}`)
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
    console.log('  register    Register this bridge on-chain')
    console.log('  start       Start the bridge server')
    console.log('  status      Show running bridge status')
    console.log('  fund        Import a funding transaction (raw hex)')
    console.log('  deregister  Deregister this bridge from the mesh')
    console.log('  secret      Show your operator secret for dashboard login')
    console.log('  backfill    Scan historical blocks for inscriptions/tokens')
    console.log('')
    console.log('Usage: relay-bridge <command> [options]')
    process.exit(command ? 1 : 0)
}

async function prompt (question, defaultValue) {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    const suffix = defaultValue ? ` (${defaultValue})` : ''
    rl.question(`${question}${suffix}: `, answer => {
      rl.close()
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function cmdInit () {
  const dir = defaultConfigDir()

  if (await configExists(dir)) {
    console.log(`Config already exists at ${dir}/config.json`)
    console.log('To re-initialize, delete the existing config first.')
    process.exit(1)
  }

  // Auto-detect IP for default name
  let publicIp = null
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
    if (res.ok) publicIp = (await res.json()).ip
  } catch {}
  const defaultName = publicIp ? 'bridge-' + publicIp.split('.').pop() : 'my-bridge'

  const name = await prompt('Bridge name', defaultName)

  const config = await initConfig(dir, { name })

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
  console.log(`  1. Fund your bridge:  send BSV to ${config.address}`)
  console.log('  2. Import funding tx: relay-bridge fund <rawTxHex>')
  console.log('  3. Register on-chain: relay-bridge register')
  console.log('  4. Start your bridge: relay-bridge start')
  console.log('')
  console.log('  Your bridge will discover the mesh automatically from the blockchain.')
  console.log(`  Dashboard: http://<your-ip>:${config.statusPort || 9333}`)
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
  const { runRegister } = await import('./lib/actions.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  console.log('Registration details:\n')

  try {
    const result = await runRegister({
      config,
      store,
      log: (type, msg) => console.log(type === 'done' ? msg : `  ${msg}`)
    })
    console.log('')
    console.log('Your bridge will appear in peer lists on next scan cycle.')
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
  const txRelay = new TxRelay(peerManager, { bridgeName: config.name })
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
  const discoveredPeers = await backfillBeaconRegistry(registeredPubkeys, config.pubkeyHex)

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
      console.log(`Handshake timeout: ${conn.pubkeyHex?.slice(0, 16) || 'unknown'}...`)
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

  // ── 6b. BSV P2P header sync — connect to BSV nodes ──────
  const { BSVNodeClient } = await import('./lib/bsv-node-client.js')

  // Auto-detect public IP for inbound P2P + addr advertisement
  let p2pPublicIp = null
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
    if (ipRes.ok) p2pPublicIp = (await ipRes.json()).ip
  } catch {}

  const bsvNode = new BSVNodeClient({
    enableInbound: true,
    listenPort: 8333,
    publicIp: p2pPublicIp,
    persistPath: join(dataDir, 'good-peers.json'),
    crawlerUrl: 'http://66.135.31.144:9333/api/crawler/peers'
  })

  // ── 6b-mesh. Bootstrap P2P from federation mesh ──────────
  // Query mesh peers for their tip height + connected BSV peer IPs
  // so we connect to P2P with an accurate height and known-good peers.
  {
    const meshPeerIps = new Set()
    let meshTip = null
    const meshConns = [...peerManager.peers.values()].filter(c => c.connected)
    if (meshConns.length > 0) {
      console.log(`[P2P] Bootstrapping from ${meshConns.length} mesh peers...`)
      const fetches = meshConns.map(async (conn) => {
        try {
          // Convert ws://IP:8333 to http://IP:9333/status
          const ep = conn.endpoint.replace('ws://', 'http://').replace('wss://', 'https://').replace(':8333', ':9333').replace(':18333', ':9333')
          const res = await fetch(`${ep}/status`, { signal: AbortSignal.timeout(5000) })
          if (!res.ok) return
          const status = await res.json()
          // Grab their tip
          if (status.headers && status.headers.bestHeight > 0) {
            if (!meshTip || status.headers.bestHeight > meshTip.height) {
              meshTip = { height: status.headers.bestHeight, hash: status.headers.bestHash }
            }
          }
          // Grab their connected BSV peer IPs
          if (status.bsvNode && status.bsvNode.peers > 0 && status.bsvNode.peerList) {
            for (const p of status.bsvNode.peerList) {
              if (p.handshake && p.host) meshPeerIps.add(p.host)
            }
          }
        } catch {}
      })
      await Promise.allSettled(fetches)
    }
    // Also use headerRelay if it already has a tip from mesh header sync
    if (headerRelay.bestHeight > 0 && (!meshTip || headerRelay.bestHeight > meshTip.height)) {
      meshTip = { height: headerRelay.bestHeight, hash: headerRelay.bestHash }
    }
    if (meshTip || meshPeerIps.size > 0) {
      bsvNode.meshBootstrap(meshTip, [...meshPeerIps])
    }
  }

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
    // Don't crash — just log. Show all errors so we can diagnose peer loss.
    console.log(`BSV P2P: ${err.code || 'ERROR'} — ${err.message}`)
  })

  // Track txids announced via BSV P2P inv (tx fetching handled by bsv-node-client relay)
  bsvNode.on('tx:inv', ({ txids }) => {
    for (const txid of txids) {
      txRelay.trackTxid(txid)
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

  // ── 6c. Teranode gossip — Pipe #4: direct miner mesh via libp2p ──
  const { TeranodeClient } = await import('./lib/teranode-client.js')
  const teranodeClient = new TeranodeClient({
    enabled: config.teranode?.enabled !== false, // enabled by default
    network: config.teranode?.network || 'mainnet'
  })

  teranodeClient.on('bestblock', ({ data }) => {
    if (data && !data.raw) {
      console.log(`Teranode: best block update — ${JSON.stringify(data).slice(0, 120)}`)
    }
  })

  teranodeClient.on('block', ({ data }) => {
    if (data && !data.raw) {
      console.log(`Teranode: new block — ${JSON.stringify(data).slice(0, 120)}`)
    }
  })

  teranodeClient.on('subtree', ({ data }) => {
    // Subtree = tx batch from miners. Future: feed into txRelay
    // For now, just count them (logged in teranode-client.js status)
  })

  teranodeClient.on('rejected_tx', ({ data }) => {
    if (data && !data.raw) {
      console.log(`Teranode: rejected tx — ${JSON.stringify(data).slice(0, 120)}`)
    }
  })

  await teranodeClient.connect()

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
    // Validate: object-style seed peers MUST have pubkeyHex to avoid undefined key in peers map
    for (let i = 0; i < seedPeers.length; i++) {
      const seed = seedPeers[i]
      if (typeof seed === 'object' && !seed.pubkeyHex) {
        console.error(`ERROR: seedPeers[${i}] missing pubkeyHex. Get it from the peer's /status endpoint or config.json.`)
        process.exit(1)
      }
    }
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
  } else if (discoveredPeers.length > 0) {
    // Zero-config: connect to peers discovered from on-chain beacon registry
    console.log(`Connecting to ${discoveredPeers.length} peer(s) discovered from on-chain registry...`)
    for (let i = 0; i < discoveredPeers.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 2000)) // stagger to avoid handshake races
      const { pubkeyHex, endpoint } = discoveredPeers[i]
      const conn = peerManager.connectToPeer({ pubkeyHex, endpoint })
      if (conn) {
        conn.on('open', () => performOutboundHandshake(conn))
      }
    }
  } else {
    console.log('No peers found. Register your bridge first: relay-bridge register')
    console.log('  Or connect manually: relay-bridge start ws://peer:port')
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
    teranodeClient,
    store,
    addressWatcher: watcher,
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

  txRelay.on('tx:new', ({ txid, rawHex }) => {
    const msg = `New tx: ${txid}`
    console.log(msg)
    statusServer.addLog(msg)

    // Fix 3: Relay mesh-received txs to BSV P2P peers.
    // If this tx came from our own BSV P2P, it's already in _seenTxids — skip.
    // Only relay txs we learned about from the federation mesh.
    if (rawHex && !bsvNode._seenTxids.has(txid)) {
      const relayed = bsvNode.broadcastTx(rawHex)
      if (relayed) {
        console.log(`[mesh→P2P] ${txid.slice(0, 12)}... relayed to BSV peers`)
      }
    }
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
    await teranodeClient.disconnect()
    gossipManager.stop()
    await statusServer.stop()
    await peerManager.shutdown()
    await store.close()
    console.log('Database closed.')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  process.on('uncaughtException', (err) => {
    console.log(`Uncaught exception: ${err.message}`)
  })
  process.on('unhandledRejection', (err) => {
    console.log(`Unhandled rejection: ${err && err.message ? err.message : err}`)
  })
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
}

async function cmdFund () {
  const rawHex = process.argv[3]

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
    if (rawHex) {
      // Manual mode: raw hex provided as argument
      await runFund({
        config,
        store,
        rawHex,
        log: (type, msg) => console.log(`  ${msg}`)
      })
    } else {
      // Auto-detect: scan bridge address for incoming UTXOs
      const addr = config.address
      if (!addr) {
        console.log('No address in config. Re-run: relay-bridge init')
        process.exit(1)
      }

      console.log(`Checking ${addr} for funds...`)

      // Query GorillaPool for unspent outputs
      let utxos = []
      try {
        const resp = await fetch(
          `https://ordinals.gorillapool.io/api/txos/address/${addr}/unspent`,
          { signal: AbortSignal.timeout(15000) }
        )
        if (resp.ok) {
          const data = await resp.json()
          if (Array.isArray(data)) utxos = data
        }
      } catch {}

      if (utxos.length === 0) {
        console.log('No funds found yet.')
        console.log(`  Send BSV to: ${addr}`)
        console.log('  Then run this command again.')
        process.exit(0)
      }

      console.log(`Found ${utxos.length} output(s). Importing...`)

      // Deduplicate by txid
      const txids = [...new Set(utxos.map(u => u.txid).filter(Boolean))]
      let imported = 0

      for (const txid of txids) {
        const hex = await fetchRawTx(txid)
        if (!hex) {
          console.log(`  Skipped ${txid.slice(0, 12)}... (could not fetch)`)
          continue
        }
        try {
          await runFund({
            config,
            store,
            rawHex: hex,
            log: (type, msg) => console.log(`  ${msg}`)
          })
          imported++
        } catch (err) {
          console.log(`  Skipped ${txid.slice(0, 12)}...: ${err.message}`)
        }
      }

      console.log(`\nDone. Imported ${imported} transaction(s).`)
    }
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
  const reason = process.argv[3] || 'shutdown'

  const { PersistentStore } = await import('./lib/persistent-store.js')
  const { runDeregister } = await import('./lib/actions.js')

  const dataDir = config.dataDir || join(dir, 'data')
  const store = new PersistentStore(dataDir)
  await store.open()

  console.log('Deregistration details:\n')

  try {
    await runDeregister({
      config,
      store,
      reason,
      log: (type, msg) => console.log(type === 'done' ? msg : `  ${msg}`)
    })
    console.log('')
    console.log('Your bridge will be removed from peer lists on next scan cycle.')
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
