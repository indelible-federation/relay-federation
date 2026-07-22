#!/usr/bin/env node
// prepublishOnly guard (F1 / reproducible releases): refuse to publish unless the bridge
// package is committed clean AND HEAD is tagged v<version>, so the published tarball's gitHead
// points at a known, reproducible commit. v5.1.1 and v5.2.0 shipped untagged — this stops that.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const run = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

function fail (msg) {
  console.error(`\n[publish-guard] REFUSING TO PUBLISH:\n  ${msg}\n`)
  process.exit(1)
}

// 1. The bridge package must be committed clean — a dirty tree means the tarball won't reproduce.
let dirty = ''
try { dirty = run('git status --porcelain -- .') } catch (e) { fail(`cannot run git (${e.message}). Publish from a git checkout.`) }
if (dirty) fail(`uncommitted changes in the bridge package:\n${dirty.split('\n').map(l => '    ' + l).join('\n')}\n  Commit them first.`)

// 2. HEAD must be tagged v<version> so gitHead points at the tagged release commit.
let tag = ''
try { tag = run('git describe --exact-match --tags HEAD') } catch { tag = '' }
if (tag !== `v${pkg.version}`) {
  fail(`HEAD is not tagged v${pkg.version} (got "${tag || '<none>'}").\n  Tag the release commit:  git tag -a v${pkg.version} -m "bridge v${pkg.version}"`)
}

console.log(`[publish-guard] OK — bridge package clean, HEAD tagged ${tag}. Publishing v${pkg.version}.`)
