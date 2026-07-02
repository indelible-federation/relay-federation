# Relay Federation — HTTP API Reference

The bridge status server exposes a REST API on port `9333` (configurable). All responses are JSON unless otherwise noted.

**Base URL:** `http://<bridge-ip>:9333`

**Authentication:** Operator endpoints require the `statusSecret` from your bridge config. Pass it as:
- Query parameter: `?auth=<secret>`
- Header: `Authorization: Bearer <secret>`

---

## Public Endpoints

### GET /status

Bridge status summary. Returns operator fields (wallet, address) only when authenticated.

**Response:**

```json
{
  "bridge": {
    "pubkeyHex": "02abc...",
    "meshId": "70016",
    "uptimeSeconds": 3600
  },
  "peers": {
    "connected": 1,
    "max": 8,
    "list": [
      {
        "pubkeyHex": "03def...",
        "endpoint": "ws://<bridge-beta-ip>:8333",
        "connected": true,
        "score": 0.92,
        "scoreBreakdown": {
          "uptime": 1.0,
          "responseTime": 1.0,
          "dataAccuracy": 0.5,
          "stakeAge": 0.28,
          "raw": {
            "pings": 12,
            "pongs": 12,
            "latencySamples": 12,
            "avgLatencyMs": 45,
            "accuracySamples": 0,
            "stakeAgeDays": 7
          }
        },
        "health": { "status": "healthy", "lastSeen": 1741700000000 }
      }
    ]
  },
  "headers": {
    "bestHeight": 890123,
    "bestHash": "00000000000000000...",
    "count": 890123
  },
  "txs": {
    "mempool": 5,
    "seen": 142
  },
  "bsvNode": {
    "connected": true,
    "peers": 2,
    "height": 890123
  }
}
```

**Authenticated response** adds:

```json
{
  "operator": true,
  "bridge": {
    "endpoint": "ws://<bridge-alpha-ip>:8333",
    "domains": ["bridge.bsvbible.club"],
    "address": "1EEtoaSuniYkoU7q16rohyHcquMNpHBRNC"
  },
  "wallet": {
    "balanceSats": 4850000,
    "utxoCount": 2
  }
}
```

---

### GET /mempool

All transactions currently in the bridge mempool, parsed with full protocol support.

**Note:** in the default self-sufficient mode this reflects the global BSV mempool as seen from P2P. If the bridge runs with `fetchGlobalTxs: false` (invs-only mode — see Configuration in the README), the local mempool contains only mesh-relayed and own-broadcast transactions.

**Response:**

```json
{
  "count": 2,
  "txs": [
    {
      "txid": "abc123...",
      "size": 226,
      "inputs": [{ "txid": "prev...", "vout": 0 }],
      "outputs": [
        {
          "vout": 0,
          "satoshis": 0,
          "isP2PKH": false,
          "hash160": null,
          "type": "op_return",
          "data": ["696e64656c69626c65", "..."],
          "protocol": "B",
          "parsed": {
            "data": "48656c6c6f",
            "mediaType": "text/plain",
            "encoding": "utf-8",
            "filename": null
          }
        },
        {
          "vout": 1,
          "satoshis": 50000,
          "isP2PKH": true,
          "hash160": "89abcdef...",
          "type": "p2pkh",
          "data": null,
          "protocol": null,
          "parsed": null
        }
      ]
    }
  ]
}
```

**Note:** OP_RETURN `data` fields are truncated to 128 hex characters in mempool responses to keep payloads small (typically under 5 KB).

**Supported `protocol` values:** `B` (B://), `BCAT` (BCAT://), `MAP`, `metanet`, `ordinal`, `bsv-20`, `null` (plain OP_RETURN or P2PKH)

---

### GET /discover

All bridges known to this node (self + gossip directory).

**Response:**

```json
{
  "count": 2,
  "bridges": [
    {
      "pubkeyHex": "02abc...",
      "endpoint": "ws://<bridge-alpha-ip>:8333",
      "meshId": "70016",
      "statusUrl": "http://<bridge-alpha-ip>:9333/status"
    },
    {
      "pubkeyHex": "03def...",
      "endpoint": "ws://<bridge-beta-ip>:8333",
      "meshId": "70016",
      "statusUrl": "http://<bridge-beta-ip>:9333/status"
    }
  ]
}
```

---

### POST /data

Submit a signed data envelope for relay to the mesh.

**Request:**

```json
{
  "topic": "oracle:rates:bsv",
  "payload": "{\"USD\":42.50}",
  "pubkeyHex": "02abc...",
  "timestamp": 1710300000,
  "ttl": 300,
  "signature": "3045..."
}
```

**Response (200):**

```json
{
  "accepted": true,
  "topic": "oracle:rates:bsv"
}
```

**Error (400):**

```json
{
  "accepted": false,
  "error": "invalid_signature"
}
```

Error codes: `missing_fields`, `payload_too_large`, `ttl_too_large`, `timestamp_future`, `expired_ttl`, `duplicate`, `invalid_signature`.

**Note:** All `/data` endpoints return `503 Service Unavailable` if the data relay module is not configured on the bridge.

---

### GET /data/topics

List all topics with cached data envelopes.

**Response (200):**

```json
{
  "count": 2,
  "topics": [
    { "topic": "oracle:rates:bsv", "count": 12, "latestTimestamp": 1710300000 },
    { "topic": "attestation:test", "count": 3, "latestTimestamp": 1710299500 }
  ]
}
```

---

### GET /data/:topic

Query cached envelopes for a topic.

**Query parameters:**
- `since` (optional) — Unix timestamp, return envelopes newer than this
- `limit` (optional) — Max envelopes to return (default 10, clamped to 1–100)

**Response (200):**

```json
{
  "topic": "oracle:rates:bsv",
  "count": 1,
  "envelopes": [
    {
      "type": "data",
      "topic": "oracle:rates:bsv",
      "payload": "{\"USD\":42.50}",
      "pubkeyHex": "02abc...",
      "timestamp": 1710300000,
      "ttl": 300,
      "signature": "3045..."
    }
  ],
  "hasMore": false
}
```

**Response (404):** Topic has no cached envelopes.

```json
{ "topic": "oracle:rates:bsv", "count": 0, "envelopes": [], "hasMore": false }
```

---

### GET /tx/:txid

Fetch and parse a transaction by txid. Checks mempool first, then BSV P2P, then WhatsOnChain fallback.

**Parameters:**
- `:txid` — 64-character hex transaction ID

**Response (200):**

```json
{
  "txid": "abc123...",
  "source": "mempool",
  "size": 226,
  "inputs": [{ "txid": "prev...", "vout": 0 }],
  "outputs": [
    {
      "vout": 0,
      "satoshis": 0,
      "isP2PKH": false,
      "hash160": null,
      "type": "op_return",
      "data": ["696e64656c69626c65"],
      "protocol": "B",
      "parsed": { "data": "...", "mediaType": "text/plain", "encoding": "utf-8" }
    }
  ]
}
```

**`source` values:** `mempool`, `p2p`, `woc`

**Error (404):** `{ "error": "tx not found: ..." }`

---

### POST /broadcast

Relay a raw transaction to all connected mesh peers.

**Request body:**

```json
{ "rawHex": "0100000001..." }
```

**Response (200):**

```json
{ "txid": "abc123...", "peers": 3 }
```

`peers` is the number of mesh peers the tx was relayed to.

---

### GET /inscriptions

Query indexed on-chain inscriptions (ordinals, B://, BSV-20).

**Query parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `mime` | string | — | Filter by content type (e.g. `image/png`) |
| `address` | string | — | Filter by receiving address |
| `limit` | number | 50 | Max results (capped at 200) |

**Response:**

```json
{
  "total": 142,
  "count": 50,
  "inscriptions": [
    {
      "txid": "abc123...",
      "vout": 0,
      "contentType": "image/png",
      "contentSize": 4096,
      "isBsv20": false,
      "bsv20": null,
      "timestamp": 1741700000,
      "address": "1Abc..."
    }
  ],
  "filters": { "mime": null, "address": null }
}
```

---

### GET /inscription/:txid/:vout/content

Serve raw inscription content with proper MIME type.

**Response:** Binary content with `Content-Type` set to the inscription's media type. Cached immutably (`Cache-Control: public, max-age=31536000, immutable`).

---

### GET /address/:addr/history

Transaction history for a BSV address. Proxied from WhatsOnChain with 60-second cache.

**Parameters:**
- `:addr` — Base58 BSV address (starts with `1` or `3`)

**Response:**

```json
{
  "address": "1Abc...",
  "history": [
    { "tx_hash": "abc123...", "height": 890100 },
    { "tx_hash": "def456...", "height": 890050 }
  ],
  "cached": false
}
```

---

### GET /apps

Health, SSL, and usage data for apps configured on this bridge.

**Response:**

```json
{
  "apps": [
    {
      "name": "BSV Bible",
      "url": "https://bsvbible.club",
      "bridgeDomain": "bridge.bsvbible.club",
      "health": {
        "status": "online",
        "statusCode": 200,
        "responseTimeMs": 120,
        "lastCheck": "2026-03-11T10:00:00.000Z",
        "lastError": null,
        "uptimePercent": 99.5,
        "checksTotal": 200,
        "checksUp": 199
      },
      "ssl": {
        "valid": true,
        "issuer": "Let's Encrypt",
        "expiresAt": "2026-06-09T00:00:00.000Z",
        "daysRemaining": 90
      },
      "usage": {
        "totalRequests": 1234,
        "endpoints": { "/status": 500, "/tx/:txid": 300, "/mempool": 200 },
        "lastSeen": "2026-03-11T10:00:00.000Z"
      }
    }
  ]
}
```

---

## Indelible Compatibility Endpoints

These `/api/` prefixed endpoints provide compatibility with the Indelible MCP client. They proxy to external data sources (WhatsOnChain, GorillaPool) with caching.

---

### GET /api/address/:addr/history

Transaction history for a BSV address. Proxied from WhatsOnChain `/confirmed/history` with 60-second cache.

**Parameters:**
- `:addr` — Base58 BSV address (starts with `1` or `3`)

**Response (200):**

```json
[
  { "tx_hash": "abc123...", "height": 890100 },
  { "tx_hash": "def456...", "height": 890050 }
]
```

**Error (502):** `{ "error": "Failed to fetch address history: ..." }`

---

### GET /api/address/:addr/balance

Balance for a BSV address. Sums unspent outputs from GorillaPool ordinals API.

**Parameters:**
- `:addr` — Base58 BSV address (starts with `1` or `3`)

**Response (200):**

```json
{ "confirmed": 5000000, "unconfirmed": 0 }
```

**Error (502):** `{ "error": "Balance fetch failed: ..." }`

---

### GET /api/tx/:txid

Full transaction JSON. Proxied from WhatsOnChain.

**Parameters:**
- `:txid` — 64-character hex transaction ID

**Response (200):** Full WoC transaction JSON (inputs, outputs, block info).

**Error (502):** `{ "error": "tx fetch failed: ..." }`

---

### GET /api/mesh/status

Alias for `GET /status`. Returns the same bridge status summary.

---

### POST /api/broadcast

Alias for `POST /broadcast`. Accepts `{ "rawHex": "..." }` and relays to mesh peers.

---

### GET /api/address/:addr/unspent

Unspent transaction outputs for a BSV address. Proxied from GorillaPool ordinals API.

**Parameters:**
- `:addr` — BSV address (base58check)

**Response (200):**

```json
[
  {
    "txid": "abc123...",
    "vout": 0,
    "satoshis": 50000,
    "script": "76a914..."
  }
]
```

---

### GET /api/tx/:txid/hex

Raw transaction hex. Checks local cache, then fetches from WhatsOnChain.

**Parameters:**
- `:txid` — 64-character hex transaction ID

**Response (200):** Raw hex string (text/plain).

**Error (404):** Transaction not found.

---

### GET /api/sessions/:address

Session metadata for a BSV address. Returns all indexed sessions from the bridge's LevelDB store. Sessions are indexed via `POST /api/sessions/index` and sync across bridges via SessionRelay.

**Parameters:**
- `:address` — BSV address (base58check)

**Response (200):**

```json
{
  "address": "1Abc...",
  "sessions": [
    {
      "txid": "abc123...",
      "address": "1Abc...",
      "timestamp": 1710000000,
      "summary": "Session summary text"
    }
  ],
  "count": 42
}
```

---

### POST /api/sessions/index

Index a session on this bridge. The session metadata is stored in LevelDB and propagated to all mesh peers via SessionRelay.

**Request body:**

```json
{
  "address": "1Abc...",
  "txid": "abc123...",
  "timestamp": 1710000000,
  "summary": "Session summary text"
}
```

**Response (200):** `{ "ok": true }`

---

### POST /api/sessions/backfill

Bulk-index sessions. Accepts an array of session objects.

**Request body:**

```json
{
  "sessions": [
    { "address": "1Abc...", "txid": "abc123...", "timestamp": 1710000000, "summary": "..." },
    { "address": "1Abc...", "txid": "def456...", "timestamp": 1710003600, "summary": "..." }
  ]
}
```

**Response (200):** `{ "ok": true, "indexed": 2 }`

---

### GET /price

Live BSV/USD exchange rate. Cached in memory with 60-second TTL, sourced from WhatsOnChain.

**Response (200):**

```json
{
  "usd": 15.23,
  "currency": "USD",
  "source": "whatsonchain",
  "cached": 1741700000000,
  "ttl": 60000
}
```

**Error (503):** `{ "error": "Price unavailable" }` — upstream fetch failed and no cached value exists.

---

### GET /tx/:txid/status

Transaction lifecycle state. Tracks every transaction the bridge has seen through mempool, confirmation, reorg, and expiry.

**Parameters:**
- `:txid` — 64-character hex transaction ID

**Response (200):**

```json
{
  "txid": "abc123...",
  "state": "confirmed",
  "firstSeen": 1741700000000,
  "lastSeen": 1741700000000,
  "source": "p2p",
  "blockHash": "00000000000000000...",
  "height": 890123,
  "updatedAt": 1741700060000,
  "block": {
    "blockHash": "00000000000000000...",
    "height": 890123,
    "proof": { "nodes": ["abc...", "def..."], "index": 3 },
    "verified": true,
    "confirmedAt": 1741700060000
  }
}
```

**State values:** `mempool` (seen, unconfirmed), `confirmed` (proven in best chain), `orphaned` (was confirmed, block disconnected by reorg), `dropped` (mempool expiry)

**Error (404):** `{ "error": "Transaction not found" }` — bridge has never seen this txid.

---

### GET /proof/:txid

Merkle proof for a confirmed transaction. Returns the proof nodes and block context needed for SPV verification.

**Parameters:**
- `:txid` — 64-character hex transaction ID

**Response (200):**

```json
{
  "txid": "abc123...",
  "blockHash": "00000000000000000...",
  "height": 890123,
  "proof": {
    "nodes": ["abc...", "def...", "ghi..."],
    "index": 3
  }
}
```

**Error (404):** `{ "error": "Proof not available" }` — tx not confirmed or no proof stored.

---

### GET /tokens

List all deployed BSV-20 tokens the bridge has indexed. Confirmed-only — mempool deploys are not included.

**Response (200):**

```json
{
  "tokens": [
    {
      "tick": "ordi",
      "max": "21000000",
      "lim": "1000",
      "decimals": 0,
      "totalMinted": "5000",
      "deployTxid": "abc123...",
      "deployHeight": 890100,
      "deployedAt": 1741700000000
    }
  ]
}
```

---

### GET /token/:tick

Deploy info for a specific BSV-20 token.

**Parameters:**
- `:tick` — Token ticker (case-insensitive, normalized to lowercase)

**Response (200):**

```json
{
  "tick": "ordi",
  "max": "21000000",
  "lim": "1000",
  "decimals": 0,
  "totalMinted": "5000",
  "deployTxid": "abc123...",
  "deployHeight": 890100,
  "deployedAt": 1741700000000
}
```

**Error (404):** `{ "error": "Token not found" }`

---

### GET /token/:tick/balance/:scriptHash

Token balance for a specific owner identified by script hash (SHA256 of locking script hex).

**Parameters:**
- `:tick` — Token ticker
- `:scriptHash` — 64-character hex SHA256 hash of the output's locking script

**Response (200):**

```json
{
  "tick": "ordi",
  "ownerScriptHash": "abc123...",
  "balance": {
    "confirmed": "1000",
    "pending": "0",
    "updatedAt": 1741700000000
  }
}
```

**Why scriptHash?** Addresses only work for P2PKH outputs. Script hash is universal — works for P2PK, P2SH, bare scripts, and any locking script type. The bridge computes `SHA256(lockingScriptHex)` for every output.

---

### GET /logs

Server-Sent Events (SSE) stream of live bridge logs. Replays the last 500 log entries on connect, then streams new entries in real time.

**Response:** `text/event-stream`

```
data: {"timestamp":1741700000000,"message":"Peer connected: 03def..."}

data: {"timestamp":1741700001000,"message":"Header relayed: height 890123"}
```

---

## Operator Endpoints

All operator endpoints require authentication via `statusSecret`.

### POST /register

Start on-chain bridge registration. Builds stake bond + registration tx, broadcasts via BSV P2P. Returns immediately with a job ID for progress tracking.

**Response (202):**

```json
{ "jobId": "job_1_1741700000000", "stream": "/jobs/job_1_1741700000000" }
```

Track progress via `GET /jobs/:id` (SSE stream).

---

### POST /deregister

Start on-chain bridge deregistration.

**Request body:**

```json
{ "reason": "shutdown" }
```

**Response (202):**

```json
{ "jobId": "job_2_1741700000000", "stream": "/jobs/job_2_1741700000000" }
```

---

### POST /fund

Store a funding transaction. Parses the raw tx and stores UTXOs paying to the bridge address. Synchronous.

**Request body:**

```json
{ "rawHex": "0100000001..." }
```

**Response (200):**

```json
{ "stored": 1, "balance": 5000000 }
```

---

### POST /connect

Connect to a peer endpoint and perform cryptographic handshake.

**Request body:**

```json
{ "endpoint": "ws://<bridge-beta-ip>:8333" }
```

**Response (200):**

```json
{ "endpoint": "ws://<bridge-beta-ip>:8333", "status": "connecting" }
```

---

### POST /send

Send BSV from the bridge wallet to a destination address.

**Request body:**

```json
{ "toAddress": "1Abc...", "amount": 50000 }
```

`amount` is in satoshis (minimum 546, dust limit).

**Response (202):**

```json
{ "jobId": "job_3_1741700000000", "stream": "/jobs/job_3_1741700000000" }
```

---

### GET /jobs/:id

SSE stream for tracking async job progress (register, deregister, send).

**Response:** `text/event-stream`

```
data: {"type":"step","message":"Building stake bond...","timestamp":1741700000000}

data: {"type":"step","message":"Stake bond txid: abc123...","timestamp":1741700001000}

data: {"type":"done","message":"Registration broadcast successful!","data":{"stakeTxid":"abc...","registrationTxid":"def..."},"timestamp":1741700002000}

data: {"type":"end","status":"completed"}
```

**Event types:** `step` (progress), `done` (success), `error` (failure), `end` (stream close)

---

### POST /scan-address

Scan a BSV address for inscriptions via WhatsOnChain. Fetches transaction history, parses each tx, and indexes any inscriptions found.

**Request body:**

```json
{ "address": "1Abc..." }
```

**Response:** SSE stream with progress updates:

```
data: {"phase":"fetching","message":"Fetching address history..."}

data: {"phase":"scanning","message":"Scanning tx 1/42...","progress":2}

data: {"phase":"complete","result":{"scanned":42,"found":3,"indexed":3}}
```

---

### POST /rebuild-inscription-index

Deduplicate and rebuild secondary inscription indexes.

**Response (200):**

```json
{ "rebuilt": 142 }
```

---

## Dashboard

### GET /

HTML dashboard with auto-refresh. Tabs: Overview, Mempool, Tx Explorer, Inscriptions, Apps.

Accessible without authentication for read-only view. Operator features (wallet, register, send) require `?auth=<secret>` in the URL.

---

## CLI Commands

### relay-bridge backfill

Walk historical blocks and index inscriptions + BSV-20 token operations.

```bash
relay-bridge backfill [--from=800000] [--to=890000]
```

**Flags:**
| Flag | Default | Description |
|---|---|---|
| `--from` | 800000 | Start block height |
| `--to` | chain tip | End block height |

**Behavior:**
- Fetches block txid lists from WhatsOnChain (one call per block)
- Selectively fetches raw tx for txids matching interest filters (ordinals, BSV-20)
- Indexes inscriptions and token operations with confirmed status
- Resume support: stores progress in `meta.backfill_height`, restarts where it left off
- Idempotency: `applied!txid` markers prevent duplicate processing
- Rate limited: 350ms between WoC API calls
- Progress logged every 100 blocks
