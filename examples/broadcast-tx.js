// Broadcast a raw transaction to the mesh
// Usage: node broadcast-tx.js <raw-tx-hex>

const API = process.env.RELAY_API_URL || 'http://localhost:9333'
const KEY = process.env.RELAY_API_KEY || 'relay_sk_your_key_here'

const rawTx = process.argv[2]
if (!rawTx) {
  console.log('Usage: RELAY_API_KEY=relay_sk_... node broadcast-tx.js <raw-tx-hex>')
  process.exit(1)
}

const res = await fetch(`${API}/api/tx/broadcast`, {
  method: 'POST',
  headers: {
    'X-API-Key': KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ rawTx })
})

if (!res.ok) {
  console.error(`Error: ${res.status} ${res.statusText}`)
  const body = await res.text()
  if (body) console.error(body)
  process.exit(1)
}

const result = await res.json()
console.log('Broadcast successful!')
console.log(`  txid: ${result.txid}`)
