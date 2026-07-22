// Check the balance of a BSV address
// Usage: node check-balance.js <address>

const API = process.env.RELAY_API_URL || 'http://localhost:9333'
const KEY = process.env.RELAY_API_KEY || 'relay_sk_your_key_here'

const address = process.argv[2]
if (!address) {
  console.log('Usage: RELAY_API_KEY=relay_sk_... node check-balance.js <address>')
  process.exit(1)
}

const res = await fetch(`${API}/api/address/${address}/balance`, {
  headers: { 'X-API-Key': KEY }
})

if (!res.ok) {
  console.error(`Error: ${res.status} ${res.statusText}`)
  process.exit(1)
}

const data = await res.json()
console.log(`Address: ${address}`)
console.log(`Balance: ${data.confirmed} sat (confirmed)`)
if (data.unconfirmed) console.log(`         ${data.unconfirmed} sat (unconfirmed)`)
