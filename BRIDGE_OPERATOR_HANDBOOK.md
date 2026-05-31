# Bridge Operator Handbook

How to set up and run your own bridge on the Indelible Federation.

## What is a bridge?

A bridge is a lightweight server that connects to the Bitcoin SV network, syncs block headers, and relays transactions. Bridges peer with each other to form a mesh network. Your bridge will discover other bridges automatically from the blockchain — no manual configuration needed.

## Requirements

| Requirement | Minimum | Recommended |
|---|---|---|
| **Node.js** | v22 LTS | v22.22+ |
| **RAM** | 1 GB | 2 GB+ |
| **Disk** | 500 MB | 1 GB |
| **OS** | Any Linux | Ubuntu 22.04+ / Debian 12+ |
| **Network** | Static IP or domain | VPS with reliable uptime |
| **BSV** | 0.01 BSV (1M sats) | For surety bond |

**Node.js version:** Use v22 LTS. Node v24+ is not yet supported — the `/status` endpoint may crash. Check with `node --version`.

**Bun:** You can use `bun install` for dependencies, but the bridge runtime requires Node.js. Bun's event loop handles idle TCP connections differently and the process will exit after a few seconds.

## Step 1: Install Node.js

SSH into your VPS and run:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

Verify it installed:

```bash
node --version
```

You should see v22 or higher.

## Step 2: Open firewall ports FIRST

Your bridge needs two ports open. Do this before starting so the mesh can reach you:

```bash
sudo ufw allow 8333/tcp    # Bitcoin P2P — connects to BSV nodes and other bridges
sudo ufw allow 9333/tcp    # Dashboard + REST API — health checks ping this port
```

If port 9333 is not open, your bridge will work but show as **offline** on the dashboard.

## Step 3: Install the bridge software

```bash
npm install -g @relay-federation/bridge@latest
```

**Use 5.1.0 or newer.** It includes native IPv6 peering, `--personal` mode, and two memory-leak fixes that matter for any long-running bridge (see CHANGELOG). Older 4.x and 5.0.x releases are superseded.

This gives you the `relay-bridge` command.

## Step 4: Initialize your bridge

```bash
relay-bridge init
```

It will ask you to name your bridge, then output something like:

```
Bridge initialized!

  Name:     my-bridge
  Config:   /root/.relay-bridge/config.json
  Endpoint: ws://123.45.67.89:8333
  Pubkey:   0245f32e453b42a9...
  Address:  1PVrvQAaHTD24w2Z137HG2HyLHbPWkWNDE
  Secret:   55621d9fdc3baa06...

  Save your operator secret! You need it to log into the dashboard.
```

**Important:** Save your operator secret somewhere safe. You need it to access the dashboard's operator panel.

## Step 5: Fund your bridge

Send BSV to the address shown in Step 3. You need at least 0.01 BSV (1,000,000 satoshis) for the stake bond.

You can send from any wallet or exchange — HandCash, Centbee, RelayX, or wherever you hold BSV.

After sending, wait for the transaction to confirm (usually a few seconds on BSV), then tell the bridge to pick it up:

```bash
relay-bridge fund
```

The bridge checks its own address automatically — no need to copy anything from a block explorer.

You should see output like:

```
Checking 1PVrv...WNDE for funds...
Found 1 output(s). Importing...
  UTXO stored: abc123....:0 (1500000 sat)
  Total balance: 1500000 satoshis
```

## Step 6: Register your bridge

```bash
relay-bridge register
```

This broadcasts a registration transaction to the BSV network. Other bridges will detect it automatically and start accepting connections from you.

You should see:

```
Registration broadcast! txid: def456...
Your bridge will appear in peer lists on next scan cycle.
```

## Step 7: Start your bridge

```bash
relay-bridge start
```

Your bridge will:
1. Connect to BSV full nodes via the P2P network
2. Sync all block headers
3. Discover other bridges from the on-chain registry
4. Connect to the mesh and start relaying transactions

You should see output like:

```
Beacon backfill: GorillaPool returned 10 UTXOs
Discovered 7 peer endpoint(s) from on-chain registry
Connecting to 7 peer(s) discovered from on-chain registry...
BSV P2P: handshake complete (/Bitcoin SV:1.2.1/, height: 944554)
Peer identified: 028eee885bd1b990...
```

## Step 8: Run as a service (systemd — recommended)

Create `/etc/systemd/system/relay-bridge.service`:

```ini
[Unit]
Description=Relay Federation Bridge
After=network.target

[Service]
ExecStart=/usr/bin/npx relay-bridge start
WorkingDirectory=/root
Restart=always
RestartSec=10
Environment=NODE_OPTIONS=--max-old-space-size=2048

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable relay-bridge    # start on boot
sudo systemctl start relay-bridge
```

**Memory:** `NODE_OPTIONS=--max-old-space-size=2048` (2GB heap) is required. Default 512MB causes OOM crashes after ~5 hours with 15+ peers.

**RestartSec=10:** Prevents "port already in use" errors by giving the old process time to release ports.

### Alternative: pm2

```bash
npm install -g pm2
pm2 start "npx relay-bridge start" --name relay-bridge --node-args="--max-old-space-size=2048"
pm2 startup    # auto-start on boot
pm2 save
```

## Step 9: Verify

Open your browser and go to:

```
http://YOUR-IP:9333
```

You should see the bridge dashboard showing your peers, mempool transactions, and block height.

From the command line, you can also check:

```bash
relay-bridge status
```

## Managing your bridge

```bash
# systemd
sudo systemctl stop relay-bridge
sudo systemctl restart relay-bridge
sudo systemctl status relay-bridge
sudo journalctl -u relay-bridge -f         # live logs
sudo journalctl -u relay-bridge --tail 100 # last 100 lines

# pm2
pm2 stop relay-bridge
pm2 restart relay-bridge
pm2 logs relay-bridge
```

---

## Enable x402 Payments

Earn satoshis from every paid write that hits your bridge. Free reads remain free.

Add to `~/.relay-bridge/config.json`:

```json
{
  "x402": {
    "enabled": true,
    "payTo": "1YourBSVAddress..."
  }
}
```

Restart the bridge. Check the x402 tab on your dashboard to see revenue stats.

---

## HTTPS with Reverse Proxy

### Caddy (simplest)

```
your-bridge.example.com {
    reverse_proxy localhost:9333
}
```

### nginx

```nginx
server {
    server_name your-bridge.example.com;
    location / {
        proxy_pass http://127.0.0.1:9333;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

The dashboard automatically proxies cross-bridge requests through your bridge server-side, so HTTPS works without mixed-content issues.

---

## IPv6 Support (Optional)

> **Status:** shipped in 5.1.0. Once you're on 5.1.0+, no config change is required for outbound IPv6 — the bridge uses IPv6 automatically whenever a BSV peer or another bridge is reachable that way. The notes below cover the cases where you want to **accept** inbound IPv6, or where IPv6 lets you escape problems IPv4 can't (peer-from-home behind CGNAT).

### Why IPv6 — and why IPv4 can't run a bridge from home

If you want to run a **full federation bridge from a home internet connection**, IPv6 isn't a nice-to-have — it's the only thing that works. Here's the why, because it trips up everyone who tries IPv4 first:

**The IPv4 problem: CGNAT.** The world ran out of IPv4 addresses years ago (there are only ~4.3 billion, all allocated). To cope, most consumer ISPs — all cellular/5G home internet (T-Mobile, Verizon), most fiber and cable for residential plans — put you behind **Carrier-Grade NAT (CGNAT)**: hundreds or thousands of customers share one public IPv4 address. You don't get a public IPv4 of your own. That means:

- **No inbound connections.** Other bridges and BSV nodes literally cannot reach you on IPv4 — there's no address that routes to your machine.
- **Port forwarding doesn't help.** You can forward ports on your own router all day; the CGNAT layer upstream (at the ISP) has no forward rule for you, and you can't add one. The packets die before they reach your router.
- **You can't even buy your way out easily.** A static IPv4 from a residential ISP is often unavailable at any price, or requires a business line.

So a home bridge on IPv4 can make *outbound* connections but can never *accept* inbound gossip — it can't be a full mesh participant. It's stuck as an outbound-only node.

**The IPv6 fix.** IPv6 has 2^128 addresses — about 340 undecillion, enough to give every device on Earth billions of its own. There's no scarcity, so there's no CGNAT: when your ISP gives you IPv6, every device gets a **real, globally-routable address**. Inbound connections work. A home machine becomes directly reachable, exactly like a VPS. That's what turns a home bridge from "outbound-only" into a **full federation member** — accepting inbound gossip, relaying, registered on-chain.

**When even inbound IPv6 is blocked.** Some ISPs (notably T-Mobile Home Internet) hand out IPv6 but firewall *inbound* IPv6 too. We hit this on a real residential connection. The fix is a small IPv6-enabled VPS (any provider, ~$3-6/mo) running as a **WireGuard hub**: it carves a `/128` from its own `/64`, NDP-proxies that address onto its public segment, and tunnels traffic for it to your home machine over WireGuard (UDP — which *does* punch through CGNAT/firewalls because it's outbound-initiated with keepalives). From the internet's view your home bridge has a real routable IPv6 address; in reality it's tunneled. One production federation bridge runs exactly this way. Full recipe in **Path 3** below.

**The other wins (beyond home bridges):**
- **Future-proofing.** Most VPS providers (Vultr, DigitalOcean, Hetzner, Linode, OVH) offer free IPv6 per-instance. Turning it on means your bridge can peer with IPv6-only BSV nodes and IPv6-only bridges as they come online — the BSV topology already has them (we connect to peers in Hurricane Electric, OVH, and Vultr IPv6 ranges within seconds of startup).
- **Edge devices.** Once IPv6 is your path, the same bridge software runs on smaller boxes — mini-PCs, NAS, ARM SBCs — without needing a dedicated public IPv4.

### Path 1 — VPS with native IPv6 (typical)

Most providers expose IPv6 via a per-instance toggle in their control panel. Once enabled, your VPS gets a `/64` (massive — billions of addresses, all yours).

**Enable IPv6 on the VPS (provider UI).** For Vultr: instance → Settings → IPv6 → Enable. Other providers similar. After enabling, reboot if the provider docs say to.

**Verify the OS sees it:**
```bash
ip -6 addr show scope global
# You should see a 2000::/3 address on your primary interface.
```

**Open IPv6 firewall ports** (in addition to the IPv4 ports from Step 2):
```bash
# ufw applies rules to both v4 and v6 by default — just confirm:
sudo grep IPV6 /etc/default/ufw
# IPV6=yes
sudo ufw status verbose | grep v6
# 8333/tcp                   ALLOW IN    Anywhere (v6)
# 9333/tcp                   ALLOW IN    Anywhere (v6)
```

If `IPV6=no` in `/etc/default/ufw`, change to `yes` and run `sudo ufw reload`.

**Bridge listens on dual-stack automatically.** The IPv6-enabled bridge software binds `::` (the IPv6 wildcard), which on Linux accepts both v4 AND v6 connections on the same socket. No config flag needed. You'll see this line in the journal on startup:

```
[P2P] Listening for inbound connections on port 8333 (dual-stack)
```

**Optional explicit bind config** (only needed if you want to override defaults):
```json
{
  "host": "::",
  "statusBindAddress": "::"
}
```

**Verify external reachability:**
```bash
# From any IPv6-reachable host:
curl -sS "http://[YOUR_V6_ADDR]:9333/health"
# {"headerHeight": ..., "connectedPeers": ..., "synced": true}
```

### Path 2 — VPS without IPv6 (still works)

If your provider doesn't offer IPv6, you don't need to do anything. The bridge stays IPv4-only and federates normally. You'll miss some IPv6-only BSV peers and won't be reachable to v6-only bridges, but the mesh keeps working.

### Path 3 — Peer-from-home behind CGNAT (advanced)

If you want to run a bridge from a home machine that has no inbound IPv4 AND no inbound IPv6 (T-Mobile Home Internet, many consumer cellular, most apartment-building shared connections), you can build an IPv6 endpoint by:

1. Renting a small IPv6-enabled VPS as a **WireGuard hub** ($3-6/mo class)
2. Carving a single `/128` out of the hub's `/64` and **NDP-proxying** it onto the hub's public segment
3. Forwarding traffic for that `/128` through a WireGuard tunnel to your home machine
4. Binding your bridge on the home machine to `::`

From the public internet's perspective, your home machine appears to have a real, routable IPv6 address — even though it's actually behind CGNAT and tunneled through your hub.

**Sketch of the hub config** (`/etc/wireguard/wg0.conf` on the VPS):
```ini
[Interface]
PrivateKey = <hub key>
Address = fd00:cafe::1/64
ListenPort = 51820

[Peer]
# Home machine
PublicKey = <home pubkey>
AllowedIPs = fd00:cafe::2/128, <carved-/128-from-hub-/64>/128
```

**Hub system tunables:**
```bash
sysctl -w net.ipv6.conf.all.forwarding=1
sysctl -w net.ipv6.conf.<wan-iface>.proxy_ndp=1
ip -6 neigh add proxy <carved-/128> dev <wan-iface>
# Persist both via /etc/sysctl.d/ + a wg-quick PostUp hook.
```

**Home machine client config** — use **specific** AllowedIPs, NOT `::/0`. On Windows, `AllowedIPs = ::/0` triggers the WireGuard kill-switch and breaks all outbound traffic on the host. Use the hub `/64` plus your provider's `/32` allocation instead:

```ini
[Interface]
PrivateKey = <home key>
Address = fd00:cafe::2/64, <carved-/128>/128

[Peer]
PublicKey = <hub pubkey>
Endpoint = <hub-public-ip>:51820
AllowedIPs = fd00:cafe::/64, 2001:19f0::/32   # Vultr's /32, adjust to your hub provider
PersistentKeepalive = 25
```

Once the tunnel is up and the carved address pings from the public internet, point your bridge config at it:
```json
{
  "host": "::",
  "endpoint": "ws://[<carved-/128>]:8333",
  "statusBindAddress": "::"
}
```

### Common pitfalls

- **AllowedIPs = ::/0 on Windows kills your network.** Always enumerate specific prefixes.
- **journald → syslog log flood.** Bridges log a lot. If `/var/log/syslog` fills your disk and your bridge OOM-spirals, add this drop-in to keep journald from forwarding to rsyslog:
  ```bash
  # /etc/systemd/journald.conf.d/zz-no-syslog-forward.conf
  [Journal]
  ForwardToSyslog=no
  ```
  Use a `zz-` prefix — vendor drop-ins ship at `/usr/lib/systemd/journald.conf.d/syslog.conf`, and conf.d merges with digits sorting BEFORE letters. A `99-` prefix loses to `syslog.conf`; `zz-` wins.
- **IPv6 firewall NOT applied.** `IPV6=no` in `/etc/default/ufw` means your v4 rules don't cover v6. Set `IPV6=yes` and `ufw reload`.
- **`AAAA` resolves but the bridge stays on IPv4.** Older bridge versions resolve seeds via `resolve4()` only. The IPv6-enabled release uses `Promise.allSettled([resolve4, resolve6])` so any IPv6-only seed becomes usable. Confirm you're on the IPv6 release.

### Verifying your IPv6 path is working

Once your bridge is running on the IPv6-enabled release with `host: "::"`:

```bash
# Confirm dual-stack listener
sudo ss -tlnp | grep :8333
# Should show "::8333" (matches both v4 and v6) — not just "0.0.0.0:8333"

# Confirm bridge picked up IPv6 peers
sudo journalctl -u relay-bridge -n 100 | grep -iE 'ipv6|aaaa|2[0-9a-f]{3}:'
# Look for outbound connect lines to bracketed v6 addresses

# Confirm /health reachable via v6
curl -sS "http://[YOUR_V6]:9333/health"
```

---

## Files & Directories

| Path | What It Is |
|------|-----------|
| `~/.relay-bridge/config.json` | Private key, endpoint, all settings |
| `~/.relay-bridge/data/` | LevelDB databases (headers, peers, txs, tokens) |
| `~/.relay-bridge/good-peers.json` | Reliable BSV peers saved for warm start |

## Troubleshooting

**Dashboard shows "offline" / HTTP 500 on :9333/status**
1. Port 9333 not open — `sudo ufw allow 9333/tcp`
2. Wrong Node.js version — use v22 LTS (`node --version`)
3. Wrong npm version — use `@relay-federation/bridge@latest` (5.1.0+)
4. Test locally: `curl http://127.0.0.1:9333/status` — if this fails too, it's a software issue not firewall

**No peers connecting**
- Make sure port 8333 is open: `ufw allow 8333/tcp`
- Check that registration completed: look for "Registration broadcast!" in your logs
- Wait a few minutes — peers discover each other through gossip, it takes time after a restart

**"Port 8333 already in use — inbound disabled"**
Previous process hasn't released the port:
```bash
sudo lsof -i :8333    # check what's using it
sudo kill <PID>        # kill stale process if needed
```
Using `RestartSec=10` in systemd prevents this on restarts.

**Teranode connection errors**
```
❌ Failed to connect to static peer /dns4/teranode-mainnet-us-01...
```
Normal. BSVA's Teranode peers go in and out. All bridges see these. Doesn't affect operation.

**Process exits immediately (Bun users)**
Bun's event loop doesn't keep the process alive for idle TCP connections. Switch to Node.js:
```bash
node $(which relay-bridge) start
```

**LevelDB LOCK error**
Previous process didn't shut down cleanly:
```bash
rm -f /root/.relay-bridge/data/*/LOCK
```

**Port already in use**
```bash
sudo fuser -k 8333/tcp
sudo fuser -k 9333/tcp
```

## Updating your bridge

When a new version is released:

```bash
pkill -f relay-bridge
npm install -g @relay-federation/bridge
nohup relay-bridge start >> /root/relay-bridge.log 2>&1 &
```

Your config and data are preserved — only the software is updated.

---

## Known Issues

| Issue | Workaround |
|-------|-----------|
| Memory grows over days | Upgrade to 5.1.0+ — fixes the perMessageDeflate + per-peer leaks |
| Bun process exits | Use Node.js for runtime (Bun OK for `install`) |
| `fund` requires raw hex | Get raw hex from whatsonchain.com — auto-detect from address planned |
| No `--version` flag | Check `npm list -g @relay-federation/bridge` instead |

---

## Quick Reference

The full setup:

```bash
# 1. Open ports
sudo ufw allow 8333/tcp && sudo ufw allow 9333/tcp

# 2. Install
npm install -g @relay-federation/bridge@latest

# 3. Init, fund, register, start
relay-bridge init
relay-bridge fund
relay-bridge register
relay-bridge start
```

Your bridge discovers the mesh automatically from the blockchain. No seed peers to configure, no manual setup needed.

---

## Personal Mode — run a bridge without joining the gossip mesh

New in 5.1.0. If you want a bridge for your own use — broadcasting transactions and reading chain data — without accepting inbound federation peers or exposing a public dashboard, use `--personal`:

```bash
relay-bridge start --personal
```

Or set it permanently in `~/.relay-bridge/config.json`:

```json
{ "personal": true }
```

What personal mode does:
- **Disables the inbound gossip WebSocket listener** — your bridge connects outward to peers but doesn't accept inbound federation connections. No need to open the gossip port to the world.
- **Binds the status dashboard to `127.0.0.1`** — the dashboard is reachable only from the machine itself, not the network.

This is the mode for a home machine, a laptop, or any node where you want the bridge's capabilities without running public infrastructure. Combine it with IPv6 (below) if you want a personal bridge that's still reachable for outbound peering from behind CGNAT.

Your explicit `statusBindAddress` and `startGossipListener` config values always win over the personal-mode defaults — set them if you want a custom mix (e.g. personal mode but with the dashboard on the LAN).

Welcome to the federation.
