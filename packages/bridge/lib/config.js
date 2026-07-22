import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'

const DEFAULT_DIR = join(homedir(), '.relay-bridge')
const CONFIG_FILE = 'config.json'

/**
 * Get the default config directory path.
 * @returns {string}
 */
export function defaultConfigDir () {
  return DEFAULT_DIR
}

/**
 * Initialize a new bridge config with a fresh key pair.
 *
 * @param {string} [dir] — Config directory (default: ~/.relay-bridge)
 * @returns {Promise<object>} The generated config
 */
export async function initConfig (dir = DEFAULT_DIR, opts = {}) {
  const privKey = PrivateKey.fromRandom()

  const address = privKey.toPublicKey().toAddress()

  // Auto-detect public IP
  let publicIp = opts.ip || null
  if (!publicIp) {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
      if (res.ok) publicIp = (await res.json()).ip
    } catch {}
  }

  const name = opts.name || (publicIp ? 'bridge-' + publicIp.split('.').pop() : 'bridge-' + privKey.toPublicKey().toString().slice(0, 8))
  const endpoint = publicIp ? 'ws://' + publicIp + ':8333' : 'ws://your-bridge-ip:8333'

  const config = {
    name,
    wif: privKey.toWif(),
    pubkeyHex: privKey.toPublicKey().toString(),
    address,
    endpoint,
    meshId: '70016',
    capabilities: ['tx_relay', 'header_sync', 'broadcast', 'address_history'],
    spvEndpoint: '', // operator-supplied SPV/registry endpoint; empty = registry peer discovery disabled (fails closed, never a default host)
    crawlerUrl: '', // operator-supplied DNS-seed-crawler endpoint (/api/crawler/peers); empty = off
    apiKey: '',
    port: 8333,
    statusPort: 9333,
    statusSecret: randomBytes(32).toString('hex'),
    dataDir: join(dir, 'data'),
    seedPeers: [],
    personal: opts.personal === true,
    // apps: [
    //   {
    //     name: 'My App',
    //     url: 'https://myapp.example.com',
    //     healthUrl: 'http://127.0.0.1:3000',  // optional — local URL for health checks (avoids DNS/TLS loopback timeout)
    //     bridgeDomain: 'bridge.myapp.example.com'
    //   }
    // ]
  }

  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, CONFIG_FILE), JSON.stringify(config, null, 2))

  return config
}

/**
 * Load an existing bridge config.
 *
 * @param {string} [dir] — Config directory (default: ~/.relay-bridge)
 * @returns {Promise<object>}
 */
/**
 * Validate config field types at load time — catch a hand-edited malformed config loudly
 * instead of at a later precedence-check site. Only checks fields that are present.
 */
export function validateConfig (config) {
  if (Object.prototype.hasOwnProperty.call(config, 'personal') &&
      typeof config.personal !== 'boolean') {
    throw new TypeError(`config.personal must be boolean (got ${typeof config.personal})`)
  }
  if (Object.prototype.hasOwnProperty.call(config, 'startGossipListener') &&
      typeof config.startGossipListener !== 'boolean') {
    throw new TypeError(`config.startGossipListener must be boolean (got ${typeof config.startGossipListener})`)
  }
  if (Object.prototype.hasOwnProperty.call(config, 'statusBindAddress') &&
      typeof config.statusBindAddress !== 'string') {
    throw new TypeError(`config.statusBindAddress must be string (got ${typeof config.statusBindAddress})`)
  }
}

export async function loadConfig (dir = DEFAULT_DIR) {
  const raw = await readFile(join(dir, CONFIG_FILE), 'utf8')
  const config = JSON.parse(raw)
  validateConfig(config)
  return config
}

/**
 * Check if a config file exists.
 *
 * @param {string} [dir] — Config directory (default: ~/.relay-bridge)
 * @returns {Promise<boolean>}
 */
export async function configExists (dir = DEFAULT_DIR) {
  try {
    await access(join(dir, CONFIG_FILE))
    return true
  } catch {
    return false
  }
}
