# Changelog — @relay-federation/bridge

All notable changes to the federation bridge package. 5.3.0 is a security + reliability release — an SSRF guard on the dashboard proxy, bounded request bodies + broadcast rate-limiting, peer-mesh connection caps, a pinned and circuit-broken Teranode feed, an x402 payment-replay fix, and no hosted default endpoint.

## 5.3.0 — 2026-07-22

**Security + reliability hardening.** A batch of fixes that close request-handling and peer-mesh attack surface, make broadcasts and payments more robust, and stop the bridge from depending on any hosted default endpoint. Drop-in upgrade from 5.2.0 — your config and data are preserved. One behavior change to note (unhandled-error exit, below); everything else is transparent.

### Security

- **SSRF guard on the dashboard mesh proxy.** `GET /mesh/proxy` previously validated only the request *path* before fetching, so a crafted `url=` could reach cloud-metadata endpoints (169.254.169.254), loopback, or private-range hosts. It now resolves the target host and rejects private / loopback / link-local / CGNAT / multicast addresses (IPv4 and IPv6, including 6to4/Teredo tunnels), pins the connection to the validated IP so a DNS rebind can't swap in an internal address between check and fetch, refuses to follow redirects, and caps the upstream response size.
- **Request bodies are bounded.** The HTTP body reader was an unbounded accumulator — any POST could grow memory without limit. Control routes now cap at 256 KiB and broadcast routes at 24 MiB (enough for a full raw transaction), returning `413` past the limit. Also fixes a latent multi-byte-UTF-8 decode bug and a hung-request leak on a dropped connection.
- **Per-IP rate limiting on broadcast**, and a **pre-handshake connection cap** so a flood of unauthenticated sockets can't exhaust file descriptors before the handshake runs.
- **Inbound WebSocket frames are size-capped** (the `ws` default is 100 MiB) so a peer can't push an oversized frame.
- **Operator dashboard no longer loads code from a third-party CDN.** Three.js and its controls are now vendored into the package and served locally, and the dashboard sends a Content-Security-Policy — so no external host can inject executable code into the origin that holds your operator secret.

### Fixed

- **Duplicate broadcasts count as success, not failure.** A transaction already in the mempool was being reported as a failed broadcast, which could make a client rebuild and resend it on the same inputs — a self-inflicted double-spend. An "already known" response is now correctly treated as success.
- **Unparseable relayed transactions no longer crash the bridge.** A non-standard or oversized transaction on the relay path could throw an unhandled error and take the process down; it is now skipped.
- **x402 payment replay fixed.** The atomic claim relied on a LevelDB put option that is silently ignored, so a claim never actually blocked a replay. Claims are now enforced with a read-check under an in-process lock. Adds fulfillment-aware receipts: a route can leave a receipt open until it has delivered a real answer, so a caller isn't charged for a failed response.
- **Teranode feed pinned to a working version.** `@bsv/teranode-listener` is now pinned to exactly `1.0.1`; a newer release does not connect to the current public network and would silently kill the feed. A reconnect circuit-breaker also stops the underlying package's unbounded reconnect loop from pegging CPU on a resource-tight host when the feed is unreachable.
- **Config is validated at load time** — a mistyped `personal`, `startGossipListener`, or `statusBindAddress` field now fails loudly instead of misbehaving later.

### Changed

- **No hosted default endpoints.** The generated config no longer defaults `spvEndpoint` or `crawlerUrl` to a hosted URL — both are empty by default, and registry / crawler peer discovery is skipped (falling back to DNS seeds + the built-in fallback nodes) unless you set your own. The bridge never phones a default host.
- **Unhandled errors now exit the process** so a supervisor (systemd `Restart=always`, pm2, docker restart-policy) can restart cleanly, instead of leaving the bridge wedged. **This is a behavior change from 5.2.x:** if you run the bridge bare with no supervisor, set `BRIDGE_SURVIVE_UNHANDLED=1` to keep the previous log-and-continue behavior.

## 5.2.0 — 2026-07-02

**Operating modes + mesh efficiency.** Adds an invs-only operating mode (`fetchGlobalTxs`) for bridges that don't need the full global transaction feed, origin-tagged mesh announcements, and per-transaction log sampling to reduce load on resource-constrained bridges.

## 5.1.1 — 2026-06-16

**Broadcast-trust fix + RNG fix + Forest dashboard art.** The bridge no longer treats an ARC HTTP 200 as a successful broadcast — it now requires a real network txStatus — so transactions ARC merely STORED (never relayed) are caught and fall through to the next path instead of being silently lost. It also fixes a crypto-RNG crash that broke the test suite and key generation on Node builds without the Web Crypto global (issue #8), and ships the Forest dashboard tab's art assets. Node 20+ is now required. Drop-in upgrade from 5.1.0 — your config and data are preserved.

### Fixed

- **ARC "STORED" broadcasts no longer counted as success.** ARC returns HTTP 200 + a txid even for a transaction it has only *stored* (persisted but never relayed to the network → permanently lost). The bridge accepted any 200/`res.ok` as broadcast success, silently losing those txs. Broadcast acceptance now gates on the ARC response `txStatus`: only `SENT_TO_NETWORK`, `ACCEPTED_BY_NETWORK`, `SEEN_ON_NETWORK`, or `MINED` count as relayed — i.e. only once a node has actually taken the transaction. A merely-stored or merely-announced status (`STORED`, `ANNOUNCED_TO_NETWORK`, `REQUESTED_BY_NETWORK`) or anything unknown is rejected, and the broadcast falls through to the next path. Covered by a new unit test (`test/arc-relayed.test.js`).
- **Forest dashboard tab art.** The Forest visualization referenced six image assets (forest floor + bridge/app/peer/ghost mushrooms + spore particle) that were never committed, so the dashboard rendered with broken images. The assets are now included.
- **@bsv/sdk RNG crash on older Node fixed (issue #8).** Running the test suite (or the bridge) on a Node build that doesn't expose the Web Crypto API as a global threw `No secure random number generator is available in this environment` from `@bsv/sdk` the moment a key was created (`PrivateKey.fromRandom`) — the SDK's `require('crypto')` fallback is dead code under ESM, so it fell through to a stub that throws. The bridge now installs a Web Crypto global from `node:crypto` (`crypto-polyfill.js`) before `@bsv/sdk` loads — at CLI startup and in the test runner — so key generation works on every supported Node version. Thanks @DanielKrawisz for the report.

### Changed

- **Node 20+ required (`engines`).** `package.json` now declares `engines.node >= 20.0.0` (was `>=18`) — Node 20 is the current LTS and the version where the Web Crypto global the SDK relies on is standard. A CI workflow runs the test suite on Node 20 and 22.

## 5.1.0 — 2026-05-31

**The "run a full federation bridge from anywhere" release.** Native IPv6 peering means you can run a complete, mesh-participating bridge from a home connection — even behind CGNAT — not just a VPS. Plus three memory-leak fixes proven on the production federation. Drop-in upgrade from 5.0.2 — your config and data are preserved.

```bash
npm install -g @relay-federation/bridge@5.1.0
# then restart your bridge
```

### Added

- **Native IPv6 peering — run a full federation bridge from home.** The bridge now connects to IPv6 BSV peers and listens dual-stack (`::`) for inbound connections: AAAA records are resolved alongside A records for seed peers, and IPv6 addresses received via BSV `addr` gossip are parsed and used (link-local, ULA, multicast, and unspecified addresses are filtered; only globally-routable addresses are kept). This is the headline: a bridge on a home machine can now be a **full mesh participant** — accepting inbound gossip, relaying, registered on-chain — reachable over IPv6 even when your ISP gives you no inbound IPv4. Set `"host": "::"` in config to bind dual-stack. One of the production federation bridges runs exactly this way from a residential connection.

  **Why IPv6 and not IPv4?** Because IPv4 *can't* run a full bridge from home. The world is out of IPv4 addresses, so consumer ISPs (all cellular/5G home internet, most residential fiber/cable) put you behind **Carrier-Grade NAT** — hundreds of customers share one public IPv4. You get no public IPv4 of your own, so nothing can reach you inbound and port forwarding can't fix it (the NAT is upstream at the ISP, not on your router). A home bridge on IPv4 is stuck outbound-only. IPv6 has no such scarcity (2^128 addresses), so there's no CGNAT — every device gets a real routable address and inbound works. If your ISP firewalls inbound IPv6 too (e.g. T-Mobile Home Internet — we hit this on a real line), a tiny IPv6 VPS as a **WireGuard hub** tunnels a routable address to your home machine over UDP (which punches through CGNAT). Full explanation + both setups in the **Bridge Operator Handbook → IPv6 Support**.
- **`--personal` mode (optional, lesser alternative).** If you do *not* want a full mesh bridge and instead want an outbound-only node — broadcasts and reads, but no inbound gossip listener and a localhost-only dashboard — start with `relay-bridge start --personal` (or `"personal": true` in config). This is a deliberately smaller mode for a private node; the default and recommended setup is a full federation bridge (above). Explicit `statusBindAddress` / `startGossipListener` config values always win.

### Fixed

- **Federation gossip memory leak (perMessageDeflate)** — every federation WebSocket connection allocated a zlib deflate context in C-allocated memory (invisible to V8 heap snapshots) that grew under traffic. `perMessageDeflate` is now disabled on both the inbound WebSocket server and outbound client connections, eliminating the leak. Any operator running federation gossip should upgrade for this fix alone.
- **Per-peer memory leak on BSV P2P churn** — disconnected BSV peers retained their socket buffer, pending-request maps, and broadcast-expiry timers via lingering closures, leaking C-allocated (`external`) memory under peer-discovery churn (hundreds of short-lived "dropped before handshake" connections per hour). Peers now release these resources on disconnect. Validated over 8+ hours: external memory stays bounded (~6–13 MB) instead of stepping up to 100+ MB and never recovering.
- **Unbounded peer-discovery sets** — the BSV node client's address pool and blacklist are now size-capped LRU maps (defaults: 50,000 addr / 10,000 blacklist, configurable via `maxAddrPool` / `maxBlacklist`) instead of unbounded sets, preventing slow heap growth on bridges exposed to heavy peer-discovery traffic.

### Changed

- **Port architecture** — federation gossip and BSV P2P are cleanly separated (gossip on the configured `port`, BSV P2P inbound on 8333), avoiding the `EADDRINUSE` collision that could silently disable one protocol when both ran on the same port.

### Operational note — journald → syslog log volume

Bridges emit a high volume of broadcast-attempt log lines. On systemd hosts, journald forwards these to `/var/log/syslog` by default, which can fill the disk on small VPSes and cause an OOM cascade. Add this drop-in to stop the forwarding:

```
# /etc/systemd/journald.conf.d/zz-no-syslog-forward.conf
[Journal]
ForwardToSyslog=no
```

Use a `zz-` prefix — vendor drop-ins ship at `/usr/lib/systemd/journald.conf.d/syslog.conf`, and conf.d files merge with digits sorting before letters, so a `99-` prefix loses to `syslog.conf` while `zz-` wins. Then `systemctl restart systemd-journald`.

---

## 5.0.2 — 2026-05-17

- Fix: `sessionRelay is not defined` reference left over from the session-layer removal in 5.0.0 (PR #7, thanks @torusJKL).

## 5.0.1 — 2026-05

- Dashboard port fix + gamma flap-fix shutdown lifecycle + Indelible-leak guard.

## 5.0.0 — 2026-05

- Remove session layer; license set to BSL-1.1.
