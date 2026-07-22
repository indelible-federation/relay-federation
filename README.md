# Indelible Federation

### The Wood Wide Web for Bitcoin

Underground, fungal threads called mycelium connect every tree in a forest — routing nutrients, sharing resources, self-healing when threads are severed. No central hub. No CEO. It's been working for 1.5 billion years.

We built the same thing for Bitcoin.

**Bridges are the mycelium.** Seven servers around the world sync headers, relay transactions, and serve a full REST API — no full node required.

**Apps are the trees.** They tap into any bridge. No node to run. No 200 GB to sync. Just `npm install` and you're on Bitcoin.

**Transactions are the nutrients.** Broadcast to one bridge, and they propagate through the mesh to the entire BSV network.

**10 bridges live. 422 tests passing. 2 continents — one running from a home connection over IPv6.**

---

## What This Is

A federated mesh network of lightweight SPV bridge nodes for BSV. Each bridge:

- Connects to 15-25 BSV full nodes via native P2P protocol (port 8333)
- Subscribes to Teranode's libp2p gossip network — block announcements, tx batches, and miner status directly from the miner mesh
- Accepts inbound connections from BSV nodes — bridges are peers, not parasites
- Syncs 945,000+ block headers and verifies Merkle proofs
- Relays novel transactions with 78-98% hit rates — earning eviction protection from full nodes
- Translates between Teranode's gossip network and Bitcoin's legacy P2P protocol — data flows both directions
- Discovers other bridges on-chain via CBOR-encoded OP_RETURN registry
- Peers with other bridges over WebSocket (port 18333) with cryptographic identity
- Serves apps via REST API (port 9333) with optional x402 micropayments
- Self-heals when any bridge goes down — traffic reroutes through others

No full node. No third-party API. No single point of failure.

---

## Live Network

| Bridge | Location | BSV Peers | Teranode | Novel Relay | Role |
|--------|----------|-----------|----------|-------------|------|
| 1 | Dallas, TX | 14-32 | 1 peer | 98% hit rate | General |
| 2 | New Jersey | 18-32 | 1 peer | 98% hit rate | General |
| 3 | Chicago, IL | 18-32 | 1 peer | 98% hit rate | General |
| 4 | Dallas, TX | 14-32 | 1 peer | 98% hit rate | General |
| 5 | Atlanta, GA | 22-32 | 1 peer | 98% hit rate | General |
| 6 | Silicon Valley | 32 | 1 peer | 98% hit rate | General |
| 7 | Silicon Valley | 25-32 | 1 peer | 98% hit rate | DNS seed crawler |
| 8 | Hetzner (EU) | 6+ | 1 peer | — | Community operator |
| 9 | bitspv.com | 5+ | 1 peer | — | Community operator |
| 10 | Home (IPv6) | 8+ | 1 peer | yes | Residential — full mesh member over IPv6 (v5.1.0) |

All bridges registered on-chain with 1M sat Surety bond. All managed by systemd. All running `NODE_OPTIONS='--max-old-space-size=2048'`. **Bridge 10 runs from a residential home connection** — a full mesh participant reachable over IPv6, proving the federation isn't VPS-only (see [Bridge Operator Handbook → IPv6 Support](BRIDGE_OPERATOR_HANDBOOK.md)).

What is a Surety Bond?

Surety Bond (BND)
This is NOT proof-of-stake. There is no staking, no delegation, and no block rewards.

A surety bond is economic collateral. Bridge operators lock BSV to their own address as a signal of commitment. The bond UTXO is monitored on-chain — if a bridge spends its bond, the network flags it and its reputation score drops.

Think of it like a security deposit: you get it back when you leave, but spending it while active tells the network you may not be serious.

How BND score works:

Bond amount — more BSV locked = higher score
Bond age — longer held unspent = more trust
Minimum bond: 0.01 BSV (1,000,000 satoshis)
BSV disabled OP_CHECKLOCKTIMEVERIFY at Genesis (Feb 2020), so script-level timelocks are not possible. Enforcement is done by monitoring the UTXO.

### Live Apps

- [bsvbible.club](https://bsvbible.club) — 31,000+ Bible verses on-chain
- [chainofthought.news](https://chainofthought.news) — Podcast episodes stored on blockchain
- [indelible.one](https://indelible.one) — AI conversation memory, encrypted files, project archives on BSV

---

## Quick Start

### For app developers

```bash
npm install @relay-federation/sdk
```

```javascript
import { RelayBridge } from '@relay-federation/sdk'

const bridge = new RelayBridge('http://your-bridge:9333')
const utxos = await bridge.getUnspent('1Address...')
const txid  = await bridge.broadcast(rawTxHex)
const mesh  = await bridge.discover()
```

The mycelium is already there. Just tap in.

### For bridge operators

```bash
npm install -g @relay-federation/bridge
relay-bridge init      # generates keypair, detects your IP
relay-bridge fund      # auto-detects BSV sent to your address
relay-bridge register  # publishes your bridge on-chain
relay-bridge start     # syncs headers, connects to mesh, serves API
```

See the [Bridge Operator Handbook](BRIDGE_OPERATOR_HANDBOOK.md) for the full walkthrough.

### Run from home (IPv6) — no VPS required

As of v5.1.0, a bridge doesn't need a datacenter. A capable PC on a home connection can be a **full mesh member** — accepting inbound peers, relaying, registered on-chain — over IPv6.

**Why IPv6, not IPv4:** the world is out of IPv4 addresses, so consumer ISPs put you behind Carrier-Grade NAT (CGNAT) — you get no public IPv4, nothing can reach you inbound, and port forwarding can't fix it (the NAT is upstream at the ISP). IPv6 has no such scarcity, so every device gets a real routable address and inbound works.

- **ISP gives you working inbound IPv6?** Setup is the same as a VPS — set `"host": "::"` and you're a full member. **Test first** (from another network: `curl http://[YOUR_V6]:9333/health`); if it answers, you're done — no extra tooling.
- **ISP firewalls inbound IPv6 (e.g. T-Mobile Home Internet)?** A small IPv6 VPS as a **WireGuard hub** tunnels a routable address to your PC over UDP (which punches through CGNAT). One of our 10 bridges runs exactly this way from a residential connection.

Full decision guide + both recipes: [Bridge Operator Handbook → IPv6 Support](BRIDGE_OPERATOR_HANDBOOK.md).

---

## Architecture

```
    Teranode Gossip (libp2p)          BSV P2P Network (port 8333)
         │                         ┌──────────┼──────────┐
         │  blocks, subtrees,      ▼          ▼          ▼
         │  status, rejected   ┌────────┐ ┌────────┐ ┌────────┐
         └────────────────────▶│Bridge A│ │Bridge B│ │Bridge C│
                               └───┬────┘ └───┬────┘ └───┬────┘
                                   │    WS    │    WS    │        ← port 18333
                                   └────┬─────┴────┬─────┘
                                        │   Mesh   │
                                   ┌────┴──────────┴────┐
                                   │  Federation Layer  │
                                   │  - Gossip          │
                                   │  - Peer Scoring    │
                                   │  - On-chain Beacon │
                                   └────────────────────┘
                                            │
                            ┌───────────────┼───────────────┐
                            ▼               ▼               ▼
                       ┌─────────┐   ┌──────────┐   ┌──────────┐
                       │ App :3000│   │ App :4000│   │ App :5000│
                       └─────────┘   └──────────┘   └──────────┘
              ARC (HTTP) ──▶ Teranode          REST API (port 9333)
              (tx broadcast)
```

Transactions enter through ARC (HTTP POST to Teranode). Bridges hear them come back through the gossip network as subtree/block announcements. Write through one pipe, hear confirmation through another.

### The Hydra — 5 Data Pipes

| # | Pipe | Transport | Direction | Status |
|---|------|-----------|-----------|--------|
| 1 | **Teranode gossip** | libp2p GossipSub | Blocks, subtrees, status IN | Live — all 10 bridges |
| 2 | **ARC** | HTTP POST | Transactions OUT to miners | Live |
| 3 | **Legacy BSV P2P** | TCP wire protocol | Headers, txs, both directions | Live — ban-prone |
| 4 | **Federation mesh** | WebSocket peering | Tx relay between bridges | Live |
| 5 | **HTTP APIs** | GorillaPool, WoC | UTXO reads, tx lookups | Live |

Any one goes down, the others keep feeding. All different transport types — no single failure mode takes out more than one.

### Three Ports, Three Protocols

| Port | Protocol | What It Does |
|------|----------|-------------|
| **8333** | TCP (Bitcoin P2P) | Outbound + inbound connections to BSV full nodes. Standard Bitcoin port. |
| **18333** | WebSocket | Bridge-to-bridge mesh: cryptographic handshake, tx relay, header sync, data envelopes. |
| **9333** | HTTP | REST API for apps, operator dashboard, x402 payments. |

---

## How We Earned Our Place on the Network

BSV full nodes don't keep peers out of charity. They run an eviction algorithm (`AttemptToEvictConnection` in `src/net/net.cpp`) with five protection layers:

| Layer | Protects | Criteria |
|-------|----------|----------|
| Netgroup | 4 peers | Different /16 subnets |
| Best ping | 8 peers | Lowest latency |
| **Novel tx relay** | **4 peers** | **Most recent `nLastTXTime` — first relayer wins** |
| Block relay | 4 peers | Most recent block delivery |
| Longest connected | 50% | Uptime |

**Layer 3 is everything.** `nLastTXTime` only updates when you deliver a transaction the full node has *never seen before*. First relayer wins. Everyone else gets nothing. If you never relay novel transactions, you have zero eviction protection and get kicked within minutes.

We read the BSV node source code (C++) alongside our bridge code (JavaScript) — two codebases, two languages, same protocol — and found four bugs in ourselves:

**Fix 1 — We were stale.** Advertised block height 930,000 in our version handshake. Chain tip was 945,500. Full nodes saw us 15,000 blocks behind — dead on arrival. Now good peers are persisted to disk and headers sync naturally after handshake. One bridge went from 3 peers to 20 in ten minutes.

**Fix 2 — We were slow.** Downloaded the full tx before telling peers about it. By then, someone else already relayed the `inv`. Now we forward the `inv` immediately, fetch the full tx in parallel. Novel relay acceptance: 0% → 98%.

**Fix 3 — We were siloed.** Transactions from the federation mesh (port 18333) were logged but never forwarded to BSV peers (port 8333). Our entire mesh traffic generated zero novel relay credit. Now mesh→P2P relay is automatic.

**Fix 4 — We were flooding.** Three overlapping reconnection cycles running simultaneously — 435 connection attempts per minute. BSV's `addrman.cpp` penalizes peers retried within 10 minutes (99% deprioritization) and marks peers "terrible" after 3 failures. We added a concurrency guard, exponential backoff (30s base, 30-min cap), and demotion after 3 consecutive failures.

**Fix 5 — We were getting banned.** Connect-disconnect spam triggered 24-hour IP bans on BSV nodes. Each reconnect attempt refreshed the ban timer — a death spiral. Now the bridge detects instant disconnects (<3 seconds, no handshake) as likely bans and applies maximum cooldown (30 minutes) to let the ban expire naturally. Result: 6 of 7 bridges recovered peers within 30 seconds of deploying the fix.

**Result:** novel relay hit rates of 98%. Peer retention from minutes to hours. The bridges went from passive consumers to active participants in the BSV transaction relay network.

### BSV Protocol Compliance — The 10 Rules

We read the BSV node source code (C++, `bitcoin-sv-1.2.1`) to learn what full nodes expect from peers. Every rule is enforced — violate any one and you get disconnected, deprioritised, or banned. Here's what we learned and how the federation implements each:

| # | BSV Node Requirement | What Happens If You Break It | Federation Implementation |
|---|---------------------|------------------------------|---------------------------|
| 1 | **`inv`/`getdata`/`tx` three-step handshake** | Unsolicited `tx` messages are silently ignored. Your transaction never reaches miners. | `bsv-node-client.js` — broadcasts always send `inv` first, serve `tx` only on `getdata` response. Never push raw `tx`. |
| 2 | **`services=0n` (NODE_NONE)** | Claiming `NODE_NETWORK` (`1n`) means full nodes will ask you for blocks. Can't serve them → misbehaving penalty. | `bsv-peer.js` — version message sets `services=0n`. We're SPV, we say we're SPV. |
| 3 | **No bloom filters** | Sending `filterload` triggers `Misbehaving(100)` → instant 24-hour ban. `NODE_BLOOM` is disabled on BSV. | Never sent. All tx lookups use direct `getdata MSG_TX` with explicit txids. |
| 4 | **Current block height in version** | Advertising stale height (e.g., 930K when tip is 945K) → deprioritised as dead node. | Good peers persisted to disk (warm start). Headers sync naturally after handshake via `getheaders`/`headers` exchange. |
| 5 | **Novel tx relay** | `nLastTXTime` only updates when you relay a tx the node has *never seen*. First relayer wins. No novel relay = no eviction protection. | Immediate `inv` forwarding + shared `_txCache` + mesh→P2P relay. 98% hit rates. |
| 6 | **Don't reconnect aggressively** | `addrman.cpp` penalises retries within 10 min (99% deprioritisation). 3 failures → "terrible". Instant disconnect = 24hr IP ban. | 30s base cooldown with exponential backoff (30-min cap). Ban detection: instant disconnect (<3s) triggers max cooldown to avoid refreshing bans. 3-fail demotion. |
| 7 | **Respond to pings** | Full nodes send `ping` with a nonce. No `pong` response → connection dropped. | `bsv-peer.js` — automatic `pong` with matching nonce on every `ping`. |
| 8 | **Send `protoconf` after handshake** | Protocol v70016+ requires `protoconf` declaring max message size. Missing it may cause large-message failures. | Sent immediately after `verack` — advertises 2MB max receive payload. |
| 9 | **Handle `authch` silently** | Mining nodes send authentication challenges (MinerID). Crashing or disconnecting on unknown messages = bad peer. | Logged and ignored. Non-mining SPV clients have no MinerID key. Connection proceeds. |
| 10 | **`relay=0` in version message** | SPV clients should not claim to relay. Nodes may send bloom-filtered data to `relay=1` peers. | Version message sets `relay=0`. We relay selectively through `inv`, not via the bloom path. |

Every rule is implemented in the bridge codebase today. This is why peers stay connected for hours instead of minutes.

---

## The DNS Seed Crisis

BSV's official DNS seeds are largely abandoned:

| Seed | Status |
|------|--------|
| seed.bitcoinsv.io | 3 peers |
| dnsseed.bitcoinsv.io | Dead |
| seed.cascharia.com | Returns nothing |
| dnsseed.cascharia.com | Returns nothing |
| seed.satoshisvision.network | 2 peers |
| dnsseed.satoshisvision.network | Dead |
| **seed.indelible.one** | **26+ verified-alive peers** |

Five peers from six legacy seeds. Two domains don't exist.

For a forest, this is worse than fire. It's the loss of spore flow. Existing trees still stand. The mycelium underground still works. But nothing new can find you.

So we built the federation's reproductive system. Bridge-7 runs a crawler that probes 2,100+ known BSV peers every five minutes, categorizing each by failure mode. The first run revealed that 74% of "known" peers were ghosts — IPs from years ago running something else entirely. The crawler prunes the ghosts. It's how the mycelium forgets dead soil and remembers live soil.

The federation now discovers peers through five independent mechanisms:
1. **Teranode gossip** — `node_status` messages from the miner mesh identify active miners and their endpoints
2. **Good peer persistence** — `good-peers.json` loaded on startup (warm start, not cold)
3. **DNS seeds** — including `seed.indelible.one` (our own, 26+ verified peers)
4. **Native P2P peer exchange** — `getaddr`/`addr` built into Bitcoin itself
5. **On-chain beacon** — bridges register on-chain, discovered by scanning the blockchain

If every legacy DNS seed dies tomorrow, the federation keeps running. If BSV P2P nodes ban us, Teranode gossip keeps feeding data.

---

## x402 Payment Middleware

Optional HTTP 402-based micropayment layer. The two-sided flywheel that makes the forest grow:

- **Free reads** — UTXO queries, tx lookups, balance checks, mempool, headers. Zero barrier for app developers.
- **Paid writes** — broadcast, session indexing, data injection. Revenue for bridge operators.
- **More apps → more write traffic → more revenue → more bridges → cheaper/faster access → more apps.**

```json
{
  "x402": {
    "enabled": true,
    "payTo": "1YourAddress...",
    "endpoints": {
      "POST /api/broadcast": 1000
    }
  }
}
```

- Single-key `u!{txid}` replay protection
- Configurable per-endpoint pricing in satoshis
- Dashboard tab: revenue stats, pricing table, receipts
- Compatible with [x402.org](https://www.x402.org/) (Coinbase, Cloudflare — 75M+ txs across chains)

---

## Features

- **Teranode gossip** — subscribes to the miner mesh via libp2p, receives block announcements, tx batches, rejected txs, and node status in real time
- **ARC broadcast** — transactions sent directly to Teranode via ARC HTTP, with federation bridges as fallback
- **SPV verification** — header sync from BSV P2P nodes, Merkle proof generation and validation
- **Transaction relay** — broadcast, lookup, UTXO queries, full address history
- **Novel tx relay** — immediate `inv` forwarding, shared tx cache, 98% hit rates
- **Inbound P2P** — bridges accept connections from BSV nodes on port 8333
- **Good peer persistence** — reliable peers saved to disk, warm start on restart
- **DNS seed crawler** — 2,100+ peers probed, `seed.indelible.one` published
- **BCH blacklist** — rejects non-BSV nodes during handshake (TCP race condition fix)
- **Inscription indexing** — ordinal inscriptions with content-addressed storage
- **BSV-20 tokens** — deploy/mint/transfer tracking, balance queries
- **Protocol parsing** — P2PKH, OP_RETURN, ordinals, B://, BCAT, MAP, MetaNet, BSV-20
- **Data envelope relay** — signed, TTL-bounded, topic-routed ephemeral data across the mesh
- **x402 micropayments** — free reads, paid writes, per-endpoint pricing
- **Price feed** — live BSV/USD
- **Federation mesh** — on-chain discovery, cryptographic handshake, peer scoring
- **Operator dashboard** — glassmorphism UI with 3D mesh topology (Three.js), 6 tabs
- **422 tests passing** (330 bridge + 92 common/registry/sdk)

---

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@relay-federation/bridge`](packages/bridge) | [![npm](https://img.shields.io/npm/v/@relay-federation/bridge)](https://www.npmjs.com/package/@relay-federation/bridge) | Bridge server — P2P, WebSocket mesh, header sync, tx relay, CLI |
| [`@relay-federation/common`](packages/common) | [![npm](https://img.shields.io/npm/v/@relay-federation/common)](https://www.npmjs.com/package/@relay-federation/common) | Shared modules — crypto, network, protocol constants |
| [`@relay-federation/registry`](packages/registry) | [![npm](https://img.shields.io/npm/v/@relay-federation/registry)](https://www.npmjs.com/package/@relay-federation/registry) | On-chain bridge registry — CBOR encoding, registration tx builders |
| [`@relay-federation/sdk`](packages/sdk) | [![npm](https://img.shields.io/npm/v/@relay-federation/sdk)](https://www.npmjs.com/package/@relay-federation/sdk) | JavaScript client SDK — connect to any bridge from your app |

## Documentation

| Document | Description |
|----------|-------------|
| [Whitepaper](docs/whitepaper.md) | Full architecture — 20 sections, BSV source code research, Wood Wide Web framing |
| [API Reference](docs/api.md) | HTTP endpoints — request/response formats for all routes |
| [Protocol Spec](docs/protocol.md) | On-chain registry, CBOR format, handshake, gossip, peer scoring |
| [App Integration](docs/app-integration.md) | How to build apps on the federation — architecture, SDK, REST, examples |
| [SDK README](packages/sdk/README.md) | Client library quick start and API reference |
| [Bridge Operator Handbook](BRIDGE_OPERATOR_HANDBOOK.md) | Step-by-step guide to set up and run a bridge |

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `relay-bridge init` | Generate keypair, auto-detect IP, create config |
| `relay-bridge start` | Start bridge — syncs headers, connects peers, serves API |
| `relay-bridge status` | Show running bridge status |
| `relay-bridge fund` | Auto-detect and import BSV sent to your address |
| `relay-bridge register` | Register on-chain with stake bond |
| `relay-bridge deregister [reason]` | Remove from mesh |
| `relay-bridge backfill` | Backfill historical inscriptions and tokens |
| `relay-bridge secret` | Show operator secret for dashboard login |

## Configuration

`relay-bridge init` creates `~/.relay-bridge/config.json`:

```json
{
  "wif": "<generated private key>",
  "pubkeyHex": "<derived compressed public key>",
  "endpoint": "wss://your-bridge.example.com:18333",
  "meshId": "70016",
  "capabilities": ["tx_relay", "header_sync", "broadcast", "address_history"],
  "port": 18333,
  "statusPort": 9333
}
```

| Field | Description |
|-------|-------------|
| `wif` | Bridge private key (WIF). Generated automatically. |
| `pubkeyHex` | Compressed public key — your bridge identity. |
| `endpoint` | Public WebSocket endpoint for mesh peering. |
| `meshId` | Mesh to join. Bridges only peer within the same mesh. |
| `capabilities` | `tx_relay`, `header_sync`, `broadcast`, `address_history` |
| `port` | WebSocket mesh port. Default `18333`. |
| `statusPort` | HTTP API + dashboard port. Default `9333`. |
| `seedPeers` | (Optional) Known peers. If empty, the bridge discovers peers from DNS seeds + built-in fallback nodes. |
| `spvEndpoint` | (Optional) Your SPV/registry endpoint for on-chain registry peer discovery. **Empty by default** — the bridge never falls back to a hosted default; leave it empty to rely on DNS seeds + fallback nodes, or point it at your own endpoint. |
| `crawlerUrl` | (Optional) A DNS-seed-crawler endpoint (`/api/crawler/peers`) for extra peer discovery. **Empty by default (off).** |
| `statusSecret` | Dashboard login secret. Generated by `init`. |
| `apps` | Apps to monitor in dashboard. `{name, url, healthUrl, bridgeDomain}` |
| `x402` | Payment config. `{enabled, payTo, endpoints}` |
| `fetchGlobalTxs` | (Optional, default `true`) Operating mode. `true` = **self-sufficient**: the bridge getdata's every globally-announced tx and sees the mempool first-hand — the standalone, no-node-required default. `false` = **invs-only**: for operators who run their own node/indexer and serve chain reads from it — the bridge still tracks announced txids, serves and mesh-relays its own broadcasts, and syncs headers, but skips downloading global tx bodies (a large CPU/memory/log saving on small VPSs; the local `/mempool` view then only contains mesh/own transactions). |

---

## Registration

Two transactions put your bridge on-chain:

1. **Stake bond** — locks 1,000,000 sats to your own address (Sybil deterrence)
2. **Registration tx** — CBOR OP_RETURN with endpoint, pubkey, capabilities, mesh ID, stake txid. 100 sats dust to beacon address.

```bash
relay-bridge fund       # import BSV sent to your address
relay-bridge register   # bridge must be stopped (LevelDB lock)
relay-bridge start      # now you're on the mesh
```

### Peer Scoring

Every bridge scores its peers locally. No centralized reputation.

```
score = 0.3 * uptime + 0.2 * response_time + 0.4 * data_accuracy + 0.1 * stake_age
```

| Factor | Weight | Measures |
|--------|--------|----------|
| Uptime | 30% | % reachable over rolling window |
| Response time | 20% | Normalized inverse latency |
| **Data accuracy** | **40%** | **% of relayed data that validates** |
| Stake age | 10% | How long the stake bond has existed |

Score < 0.3 → auto-disconnect. Score < 0.1 → 24-hour blacklist. Data accuracy is weighted highest because correct data is the primary function. Fake bridges get caught fast.

---

## Operational Notes

### Managing bridges (systemd)

All production bridges run as systemd services:

```bash
# Restart
sudo systemctl restart relay-bridge

# View logs
sudo journalctl -u relay-bridge -f

# Check status
sudo systemctl status relay-bridge
```

**Memory:** All bridges must run with `NODE_OPTIONS='--max-old-space-size=2048'` (2GB heap). The default 512MB causes OOM crashes after ~5 hours with 15+ peers, full header chain, and LevelDB indexes.

### Deploy updates

```bash
# Pack locally
cd relay-federation
npm pack --workspace=packages/common --workspace=packages/registry --workspace=packages/bridge

# SCP and install
scp relay-federation-*.tgz root@<IP>:/tmp/
ssh root@<IP> "npm install -g /tmp/relay-federation-common-*.tgz /tmp/relay-federation-registry-*.tgz /tmp/relay-federation-bridge-*.tgz"

# Restart
ssh root@<IP> "systemctl restart relay-bridge"
```

### Dashboard

Access at `http://<IP>:9333`. Login with operator secret (`relay-bridge secret`).

Tabs: Overview | Mempool | Explorer | Inscriptions | Tokens | Apps

### Alternative installs

**Standalone binary** (no Node.js required):
```bash
chmod +x relay-bridge-linux && ./relay-bridge-linux start
```

**Docker:**
```bash
docker run -v ~/.relay-bridge:/root/.relay-bridge \
  -p 8333:8333 -p 18333:18333 -p 9333:9333 \
  relay-federation/bridge
```

### Building on the federation

Apps are consumers of the REST API — they run anywhere and talk to bridges over HTTP. See **[Building Apps on the Federation](docs/app-integration.md)**.

---

## Prerequisites

| Dependency | Minimum | Notes |
|---|---|---|
| Node.js | 22.0.0 | Required for Teranode listener (libp2p gossipsub race condition on v20) |
| npm | 7.0.0 | Workspace support |

Runtime dependencies (auto-installed):

| Package | Purpose |
|---|---|
| `@bsv/sdk` | secp256k1, ECDSA, transaction building |
| `@bsv/teranode-listener` | Teranode libp2p gossip subscription |
| `level` | LevelDB (headers, peers, txs, tokens) |
| `ws` | WebSocket mesh peering |
| `cborg` | CBOR encoding for on-chain registry |

No native compilation. No external services. Single Node.js process.

## Development

```bash
git clone https://github.com/indelible-federation/relay-federation.git
cd relay-federation
npm install
npm test --workspace=packages/bridge   # 330 tests
```

---

## The Punchline

Forests don't have CEOs. They don't have SLA guarantees. They don't have Series A funding.

They just work. For a billion years.

Because the incentives align. The old trees help the young ones because a healthy forest benefits everyone. The mycelium spreads because there's value in connecting more nodes.

That's what we built. **An ecosystem.**

The mycelium is live. Just tap in.

---

*No ICO. No token. No VC backing. Just working infrastructure you can use today.*

*Inspired by a forest. Built on Bitcoin SV.*

## License

Business Source License 1.1 (BSL) — see [LICENSE](LICENSE)

Free for personal, educational, and non-commercial use. Commercial use of competing relay/federation services requires written permission from the Licensor. Converts to MIT on April 23, 2030.
