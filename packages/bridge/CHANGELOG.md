# Changelog — @relay-federation/bridge

All notable changes to the federation bridge package. Six improvements in 5.1.0: native IPv6 peering (run a full bridge from home), three memory-leak fixes, the LRU peer-set cap, and the gossip/P2P port split.

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
