// Check mesh health — are the bridges up?
// Usage: node mesh-health.js

const API = process.env.RELAY_API_URL || 'http://localhost:9333'
const KEY = process.env.RELAY_API_KEY || 'relay_sk_your_key_here'

const res = await fetch(`${API}/health`, {
  headers: { 'X-API-Key': KEY }
})

if (!res.ok) {
  console.error(`Gateway returned ${res.status}`)
  process.exit(1)
}

const health = await res.json()
console.log('Mesh Health\n')

if (health.bridges) {
  for (const bridge of health.bridges) {
    const dot = bridge.healthy ? '[OK]' : '[DOWN]'
    console.log(`  ${dot} ${bridge.id || bridge.host} — ${bridge.peers || '?'} peers, height ${bridge.height || '?'}`)
  }
} else {
  console.log(JSON.stringify(health, null, 2))
}
