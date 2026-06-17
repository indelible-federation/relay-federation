# Protocol Support Handbook

The relay federation bridge parses BSV transactions beyond simple P2PKH. Every output is typed, protocol-detected, and returned as structured data via the API and dashboard.

---

## Quick Reference

### Lookup a Transaction
```bash
curl http://<your-bridge-ip>:9333/tx/d312e66b15eed296497c3d3855df6e07e0380feca46d3cf68da3ba5d58804f00
```

Returns fully parsed JSON with `type`, `protocol`, `parsed` for each output.

### Get Mempool with Protocol Data
```bash
curl http://<your-bridge-ip>:9333/mempool
```

Each output includes `type`, `protocol`, `parsed` fields alongside `vout`, `satoshis`, `hash160`.

---

## Supported Output Types

| Type | Detection | Fields |
|---|---|---|
| `p2pkh` | `76a914{20 bytes}88ac` | `hash160` |
| `op_return` | `6a...` or `006a...` | `data[]`, `protocol`, `parsed` |
| `ordinal` | Contains `0063036f7264` | `contentType`, `content`, `isBsv20`, `bsv20` |
| `p2sh` | `a914{20 bytes}87` | `scriptHash` |
| `multisig` | Ends with `ae` | `m`, `n`, `pubkeys[]` |
| `unknown` | Anything else | (none) |

## Supported Protocols (inside OP_RETURN)

| Protocol | Prefix Address | Parsed Fields |
|---|---|---|
| `b` (B://) | `19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut` | `data`, `mimeType`, `encoding`, `filename` |
| `bcat` | `15DHFxWZJT58f9nhyGnsRBqrgwK4W6h4Up` | `info`, `mimeType`, `charset`, `filename`, `flag`, `chunkTxids[]` |
| `bcat-part` | `1ChDHzdd1H4wSjgGMHyndZm6qxEDGjqpJL` | `data` |
| `map` (MAP) | `1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5` | `action`, `pairs: { key: value }` |
| `metanet` | Magic bytes `6d657461` ("meta") | `nodeAddress`, `parentTxid` |
| `bsv-20` | Ordinal with `application/bsv-20` | `bsv20: { p, op, tick/id, amt, ... }` |

---

## API Response Shape

### `GET /tx/:txid`

```json
{
  "txid": "d312e66b...",
  "source": "woc",
  "size": 285,
  "inputs": [
    { "prevTxid": "abc123...", "prevVout": 0 }
  ],
  "outputs": [
    {
      "vout": 0,
      "satoshis": 0,
      "scriptHex": "6a...",
      "hash160": null,
      "isP2PKH": false,
      "type": "op_return",
      "data": ["19486x...", "48656c6c6f", "746578742f706c61696e"],
      "protocol": "b",
      "parsed": {
        "data": "48656c6c6f",
        "mimeType": "text/plain",
        "encoding": null,
        "filename": null
      }
    },
    {
      "vout": 1,
      "satoshis": 546,
      "scriptHex": "76a914...",
      "hash160": "de37babdd5a78f707274f45434b5a3e86eb652ae",
      "isP2PKH": true,
      "type": "p2pkh",
      "data": null,
      "protocol": null,
      "parsed": null
    }
  ]
}
```

**Source values:** `mempool` (bridge mempool), `p2p` (fetched from BSV network), `woc` (WhatsonChain API fallback)

### `GET /mempool`

Same output shape per tx. Protocol fields included on every output.

---

## Data Flow

```
Tx arrives (P2P / broadcast / WoC lookup)
  │
  ├─ parseTx(rawHex)
  │    └─ for each output: parseOutputScript(scriptHex)
  │         ├─ P2PKH? → { type: 'p2pkh', hash160 }
  │         ├─ OP_RETURN? → parseOpReturn() → detectProtocol()
  │         │    ├─ B://? → parseBProtocol()
  │         │    ├─ BCAT? → parseBCATLinker()
  │         │    ├─ BCAT-part? → parseBCATPart()
  │         │    ├─ MAP? → parseMAP()
  │         │    └─ MetaNet? → parseMetaNet()
  │         ├─ Ordinal? → parseOrdinal()
  │         │    └─ BSV-20? → parse JSON body
  │         ├─ P2SH? → parseP2SH()
  │         ├─ Multisig? → parseMultisig()
  │         └─ Unknown
  │
  └─ JSON response with all fields
```

---

## Files

| File | Role |
|---|---|
| `packages/bridge/lib/output-parser.js` | All parsing logic. Exports: `parseTx`, `parseOutputScript`, `parseOpReturn`, `parseOrdinal`, `pubkeyToHash160`, `addressToHash160`, `checkTxForWatched` |
| `packages/bridge/test/output-parser.test.js` | 383 tests (23 protocol-specific + 115 indexing) |
| `packages/bridge/lib/status-server.js` | Serves `/tx/:txid` and `/mempool` endpoints |
| `dashboard/index.html` | Protocol badges, Tx Explorer, parsed data rendering |

---

## Backward Compatibility

- `isP2PKH` and `hash160` still returned on every output (unchanged)
- `checkTxForWatched()` still works exactly as before (only checks P2PKH)
- `address-watcher.js` needs zero changes
- New fields (`type`, `data`, `protocol`, `parsed`) are purely additive

---

## Dashboard Features

### Protocol Badges
Color-coded badges on every output:
- **P2PKH** (blue) — standard payment
- **OP_RETURN** (purple) — data carrier
- **B://** (green) — on-chain file
- **BCAT** (teal) — chunked file
- **MAP** (orange) — metadata
- **METANET** (cyan) — tree data
- **BSV-20** (gold) — fungible token
- **ORDINAL** (red) — inscription
- **P2SH** (gray) — legacy script hash
- **MULTISIG** (gray) — multi-signature

### Transaction Explorer
In the side panel when a bridge is selected:
1. Paste any txid into the input
2. Press Enter or click Lookup
3. Bridge fetches the tx (mempool → P2P → WoC) and returns parsed data
4. Every output displayed with protocol badge + structured parsed fields

### Clickable Mempool Txids
Click any txid in the mempool list → auto-fills the Tx Explorer and triggers lookup.

### Apps Tab
Configure apps in `~/.relay-bridge/config.json`:
```json
"apps": [
  {
    "name": "My App",
    "url": "https://myapp.example.com",
    "healthUrl": "http://127.0.0.1:3000",
    "bridgeDomain": "bridge.myapp.example.com"
  }
]
```

Fields:
- **url** — Public URL shown in dashboard and used for health checks by default
- **healthUrl** (optional) — Local URL for health checks. Use this when your app runs behind nginx on the same VPS. Without it, the bridge health-checks itself through DNS → public IP → TLS → nginx, which can timeout and show false errors. Point this to `http://127.0.0.1:<port>` or `http://127.0.0.1:9333/status` (the bridge itself) to avoid loopback timeouts.
- **bridgeDomain** — The domain that proxies to your bridge (for request tracking)

### Forest Tab
The federation rendered as a living mycelial forest. Each BSV peer, app, and bridge is a mushroom on the forest floor with drifting spore particles; hover any entity for its host, user-agent, and block height. Backed by the live `forest` data feed (peers / apps / bridges).

---

## Adding a New Protocol

1. **Add prefix constant** in `output-parser.js` (e.g. `const NEW_PREFIX = '1NewAddress...'`)
2. **Add parser function** (e.g. `function parseNewProtocol(pushes) { ... }`)
3. **Add detection** in `detectProtocol()` — check `firstPush === NEW_PREFIX`
4. **Add tests** in `output-parser.test.js` — construct a script hex, verify parsing
5. **Add CSS badge** in `dashboard/index.html` (`.proto-badge.new-protocol`)
6. **Add rendering** in `renderParsedData()` — display the parsed fields
7. Run `npm test --workspace=packages/bridge` — all tests must pass

---

## Known Protocol Byte Patterns

```
P2PKH:           76a914{20 bytes}88ac
OP_RETURN:       6a{pushdata...}
OP_FALSE RETURN: 006a{pushdata...}
P2SH:            a914{20 bytes}87
Multisig:        5{m}{pubkeys}5{n}ae
Ordinal:         ...0063036f7264...68  (OP_FALSE OP_IF PUSH3"ord" ... OP_ENDIF)
MetaNet magic:   6d657461 ("meta" as 4 hex bytes)
```

## OP_RETURN Push Encoding

| Byte | Meaning |
|---|---|
| `0x00` | OP_0 — pushes empty data |
| `0x01`–`0x4b` | Direct push — next N bytes are data |
| `0x4c` | OP_PUSHDATA1 — next 1 byte is length |
| `0x4d` | OP_PUSHDATA2 — next 2 bytes (LE) is length |
| `0x4e` | OP_PUSHDATA4 — next 4 bytes (LE) is length |
| `0x51`–`0x60` | OP_1 through OP_16 — pushes number |

---

## Transaction Confirmation Tracking

Every tx the bridge sees is tracked through a lifecycle: `mempool` → `confirmed` → `orphaned` → `dropped`.

### Check tx status
```bash
curl http://<your-bridge-ip>:9333/tx/d312e66b15eed296497c3d3855df6e07e0380feca46d3cf68da3ba5d58804f00/status
```

Returns `{ state, firstSeen, lastSeen, source, blockHash?, height?, block? }`.

### Get Merkle proof
```bash
curl http://<your-bridge-ip>:9333/proof/d312e66b15eed296497c3d3855df6e07e0380feca46d3cf68da3ba5d58804f00
```

Returns `{ txid, blockHash, height, proof: { nodes[], index } }`. 404 if not confirmed.

---

## Price Feed

### Get BSV/USD price
```bash
curl http://<your-bridge-ip>:9333/price
```

Returns `{ usd, currency, source, cached, ttl }`. Cached 60 seconds, sourced from WoC.

---

## BSV-20 Token Tracking

Tokens are indexed from confirmed transactions only (no mempool). Deploy + mint supported; transfers deferred to Phase 2.

### List all tokens
```bash
curl http://<your-bridge-ip>:9333/tokens
```

### Get token deploy info
```bash
curl http://<your-bridge-ip>:9333/token/ordi
```

### Check token balance by scriptHash
```bash
curl http://<your-bridge-ip>:9333/token/ordi/balance/abc123def456...
```

**scriptHash** = SHA256 of the locking script hex. Universal — works for P2PKH, P2PK, P2SH, bare scripts.

### Token rules enforced
- First deploy wins (chain-ordered by block height)
- Tick normalized to lowercase
- Mint validates: amount <= per-tx limit, totalMinted + amount <= max supply
- All ops written as atomic LevelDB `batch()` with idempotency markers

---

## Content-Addressed Storage (CAS)

Inscription content is stored by SHA256 hash to deduplicate and reduce DB pressure.

| Size | Where |
|---|---|
| < 4 KB | Inline in LevelDB |
| >= 4 KB | Filesystem: `data/content/<first2>/<hash>` |

Content served at `/inscription/:txid/:vout/content` with immutable cache headers.

---

## Historical Backfill

Walk historical blocks and index inscriptions + BSV-20 token ops:

```bash
relay-bridge backfill --from=800000 --to=890000
```

| Flag | Default | Description |
|---|---|---|
| `--from` | 800000 | Start height |
| `--to` | chain tip | End height |

- Resumes from `meta.backfill_height` if interrupted
- Rate limited: 350ms between WoC calls
- `applied!txid` markers prevent duplicate processing
- Progress logged every 100 blocks

---

## Session Storage

Bridges store Indelible session metadata in a `sessions` LevelDB sublevel. Sessions are indexed by `{address}:{txid}` and contain `txid`, `address`, `timestamp`, and `summary`.

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:address` | GET | All sessions for an address (sorted by timestamp desc) |
| `/api/sessions/index` | POST | Index a single session `{ address, txid, timestamp, summary }` |
| `/api/sessions/backfill` | POST | Bulk-index sessions `{ sessions: [...] }` |

### Peer Sync (SessionRelay)

Sessions propagate across the mesh via WebSocket. When a bridge indexes a new session, it sends `session_index` to all peers. New peers pull the full catalog on connect via `session_sync`. Deduplication is by key (`address:txid`), so duplicate indexes are harmless.

---

## Files (updated)

| File | Role |
|---|---|
| `packages/bridge/lib/output-parser.js` | Parsing + `scriptHash` on every output |
| `packages/bridge/lib/persistent-store.js` | Storage: txStatus, txBlock, content (CAS), tokens, sessions sublevels |
| `packages/bridge/lib/status-server.js` | All HTTP endpoints including price, tokens, proof, tx status, sessions |
| `packages/bridge/lib/session-relay.js` | WebSocket session sync between peers (SessionRelay) |
| `packages/bridge/cli.js` | CLI commands including `backfill` |
| `packages/bridge/test/persistent-store.test.js` | Indexing tests (confirmation, CAS, tokens, backfill) |
| `dashboard/index.html` | Protocol badges, Tx Explorer, parsed data rendering |

---

## Test Txids (for manual verification)

These are real BSV transactions you can test with:

- **Weather oracle (OP_RETURN):** `d312e66b15eed296497c3d3855df6e07e0380feca46d3cf68da3ba5d58804f00`
- **BSV-20 ordinal transfer:** `2759a10d64f04e43691c6e458f2489bf58056c5e29cac5886abbbf53eb8e44a6`
- **MetaNet node:** `ded39e1941c80aba4854ed6405649a65008ce294ac7ecbbd099f3244ef79d776`
