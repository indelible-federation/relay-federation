// Look up a transaction by txid
// Usage: node lookup-tx.js <txid>

const API = process.env.RELAY_API_URL || 'http://localhost:9333'
const KEY = process.env.RELAY_API_KEY || 'relay_sk_your_key_here'

const txid = process.argv[2]
if (!txid) {
  console.log('Usage: RELAY_API_KEY=relay_sk_... node lookup-tx.js <txid>')
  process.exit(1)
}

const res = await fetch(`${API}/api/tx/${txid}`, {
  headers: { 'X-API-Key': KEY }
})

if (!res.ok) {
  console.error(`Error: ${res.status} ${res.statusText}`)
  process.exit(1)
}

const tx = await res.json()
console.log(JSON.stringify(tx, null, 2))
