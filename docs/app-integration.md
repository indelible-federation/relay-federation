# Building Apps on the Federation

Apps are **consumers** of the federation, not tenants on a specific bridge. Your app runs anywhere — Railway, Vercel, your own VPS, or even a static site. It talks to bridges via REST or the SDK. If one bridge goes down, your app fails over to the next.

## Architecture

```
Your App (runs anywhere)        Federation (pure infra)
┌──────────────┐               ┌─────────────────────┐
│ Railway      │──REST/SDK──▶  │ bridge-alpha         │
│ Vercel       │──REST/SDK──▶  │ bridge-beta          │
│ Your VPS     │──REST/SDK──▶  │ bridge-gamma         │
│ Static site  │──REST/SDK──▶  │ bridge-delta  ...    │
└──────────────┘               └─────────────────────┘
```

Bridges sync data between themselves (headers, sessions, transactions). Your app only needs to reach one bridge — any bridge — to access the full mesh.

## Integration Tiers

### Tier 1: Read-Only

Query transaction history, inscriptions, tokens, and bridge status. No keys needed.

```javascript
import { RelayBridge } from '@relay-federation/sdk'

const bridge = new RelayBridge('http://bridge-alpha:9333')
const history = await bridge.getAddressHistory('1Abc...')
const images = await bridge.getInscriptions({ mime: 'image/png', limit: 10 })
const mesh = await bridge.discover()
```

Or with plain REST:

```bash
curl http://bridge-alpha:9333/address/1Abc.../history
curl http://bridge-alpha:9333/inscriptions?mime=image/png&limit=10
curl http://bridge-alpha:9333/discover
```

### Tier 2: Broadcast

Build and sign transactions client-side, then broadcast via any bridge. Your private key never leaves your app.

```javascript
import { Transaction, PrivateKey, P2PKH } from '@bsv/sdk'

// Build tx locally
const tx = new Transaction()
// ... add inputs, OP_RETURN output, sign with local key ...
const rawHex = tx.toHex()

// Broadcast to the mesh
const result = await bridge.broadcast(rawHex)
console.log(`Relayed to ${result.peers} peers`)
```

Or with plain REST:

```bash
curl -X POST http://bridge-alpha:9333/broadcast \
  -H 'Content-Type: application/json' \
  -d '{"rawHex": "0100000001..."}'
```

### Tier 3: Full Integration

Read + broadcast + session indexing + multi-bridge failover. This is what Indelible uses in production.

```javascript
const BRIDGES = [
  // List the bridge endpoints you read/broadcast through — the mesh self-discovers the
  // rest, so a few is enough for failover.
  'http://your-bridge-1:9333',
  'http://your-bridge-2:9333',
]

let roundRobin = 0

async function meshFetch(path, options = {}) {
  const startIdx = roundRobin++ % BRIDGES.length
  for (let i = 0; i < BRIDGES.length; i++) {
    const url = BRIDGES[(startIdx + i) % BRIDGES.length]
    try {
      const res = await fetch(`${url}${path}`, {
        ...options,
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok || res.status === 404) return res
    } catch (_) { /* try next bridge */ }
  }
  throw new Error('All bridges failed')
}

// Use it
const history = await meshFetch('/api/address/1Abc.../history')
const broadcast = await meshFetch('/broadcast', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rawHex: '0100...' }),
})
```

**Auto-discovery:** You can also seed from one bridge and discover the rest dynamically:

```javascript
const entry = new RelayBridge('http://any-bridge:9333')
const mesh = await entry.discover()
const BRIDGES = mesh.bridges.map(b => b.statusUrl)
```

## Session Indexing

After broadcasting an OP_RETURN transaction, you can index its metadata on bridges for fast retrieval later (no blockchain scan needed):

```bash
curl -X POST http://bridge-alpha:9333/api/sessions/index \
  -H 'Content-Type: application/json' \
  -d '{
    "address": "1Abc...",
    "txid": "abc123...",
    "timestamp": 1710000000,
    "summary": "My session summary"
  }'
```

Sessions sync across all bridges automatically via SessionRelay. Index on one bridge, read from any bridge:

```bash
curl http://bridge-beta:9333/api/sessions/1Abc...
```

## Bridge Monitoring (Apps Tab)

The Apps tab in the bridge dashboard monitors app health — it doesn't host apps. Any bridge operator can add your app to their monitoring config:

```json
{
  "apps": [
    {
      "name": "My App",
      "url": "https://myapp.com",
      "healthUrl": "https://myapp.com/health",
      "bridgeDomain": "bridge.myapp.com"
    }
  ]
}
```

The dashboard shows health status, SSL certificate info, latency, and uptime for each configured app. This is purely observational — your app runs independently.

## REST Endpoints Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Bridge health, peers, headers, mempool |
| `/mempool` | GET | Parsed mempool transactions |
| `/tx/:txid` | GET | Fetch and parse a transaction |
| `/api/tx/:txid/hex` | GET | Raw transaction hex |
| `/broadcast` | POST | Broadcast raw tx to mesh (`{ rawHex }`) |
| `/address/:addr/history` | GET | Transaction history |
| `/api/address/:addr/history` | GET | History (LevelDB-first, WoC fallback) |
| `/api/address/:addr/unspent` | GET | UTXOs (GorillaPool ordinals proxy) |
| `/inscriptions` | GET | Query indexed inscriptions |
| `/inscription/:txid/:vout/content` | GET | Raw inscription content |
| `/discover` | GET | All bridges on the mesh |
| `/price` | GET | Live BSV/USD exchange rate |
| `/api/sessions/:address` | GET | Session metadata for an address |
| `/api/sessions/index` | POST | Index a session on this bridge |
| `/apps` | GET | Health status of monitored apps |

## Production Checklist

- [ ] Use 8-second timeouts per bridge request
- [ ] Round-robin across 2+ bridges for failover
- [ ] Build and sign transactions client-side (never send WIF to server)
- [ ] Use `/discover` to refresh your bridge list periodically
- [ ] Handle 404s gracefully (tx not found is not an error)
- [ ] Add your app to bridge configs for monitoring (optional)
