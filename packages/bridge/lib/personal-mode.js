// g-192 Phase 2 V3 — Personal Bridge mode helpers
//
// Extracted from cli.js so tests can import without triggering the CLI switch.
// cli.js re-exports / imports these for runtime use.
//
// Precedence: CLI --personal flag > config.personal field > default false.
// applyModeDefaults() owns personal-mode defaults so PeerManager + StatusServer
// remain dumb executors. User-set values in config.json always win
// (hasOwnProperty check, not truthiness).
//
// R2 pack catch (txid 111f62fc19dc...): defaulting startGossipListener inside
// PeerManager via ?? true would have silently re-enabled gossip in --personal
// mode. Defaults live here; PeerManager treats the option as authoritative.

import { readFile, access, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export function parseFlags (argv) {
  const flags = { personal: false, force: false }
  for (const arg of argv) {
    if (arg === '--personal') flags.personal = true
    else if (arg === '--force') flags.force = true
  }
  return flags
}

export function applyModeDefaults (config, isPersonal) {
  if (!isPersonal) return config
  const result = { ...config }
  if (!Object.prototype.hasOwnProperty.call(config, 'statusBindAddress')) {
    result.statusBindAddress = '127.0.0.1'
  }
  if (!Object.prototype.hasOwnProperty.call(config, 'startGossipListener')) {
    result.startGossipListener = false
  }
  return result
}

export function warnOnModeMismatch (config, warnFn = console.warn) {
  if (config.personal === false && config.statusBindAddress === '127.0.0.1') {
    warnFn('[WARN] config.personal=false but statusBindAddress=127.0.0.1 — did you mean to set personal:true?')
  }
}

export async function isBridgeRunning (pidFile) {
  try {
    await access(pidFile)
  } catch {
    return false  // no pid file → assume stopped
  }
  let raw
  try {
    raw = await readFile(pidFile, 'utf8')
  } catch {
    return false  // unreadable → can't confirm running
  }
  const pid = parseInt(raw.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return false  // corrupt/stale
  // R2 pack minor catch: try/catch process.kill(pid, 0) — ESRCH means dead,
  // EPERM means alive-but-not-ours (still counts as running).
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err && err.code === 'EPERM') return true  // exists, no permission
    return false  // ESRCH or other → not running
  }
}

export async function atomicWriteConfig (dir, config) {
  const finalPath = join(dir, 'config.json')
  const tmpPath = join(dir, `config.json.tmp.${process.pid}.${Date.now()}`)
  await writeFile(tmpPath, JSON.stringify(config, null, 2))
  // Diff-pack #3 (txid a325714069a0...): on rename failure (perms, cross-device,
  // disk full), clean up the orphan tmp file so the dir doesn't accumulate cruft.
  try {
    await rename(tmpPath, finalPath)
  } catch (err) {
    try { await unlink(tmpPath) } catch {}
    throw err
  }
}
