# Overlay Registration Migration Guide

## What Changed

Bridge registration now uses SHIP tokens on the overlay directory instead of beacon OP_RETURN transactions. This gives bridges:

- Revocable registration (spend the SHIP token to deregister)
- Overlay-based discovery (peers find you via directory lookup, not beacon scanning)
- BRC-42 derived keys (registration key is isolated from the master identity)
- One identity across wire handshakes and on-chain registration

## For Existing Bridge Operators

### Step 1: Update to latest version

```bash
cd /opt/relay-federation
git pull origin main
npm install
```

### Step 2: Ensure the overlay directory is running

The bridge needs a reachable overlay node. If you run one locally:

```bash
# Check overlay status
curl -s http://127.0.0.1:3360/status
```

If using a remote overlay, add to your bridge config:

```json
{
  "overlayUrl": "http://overlay-host:3360"
}
```

Default is `http://127.0.0.1:3360`.

### Step 3: Register via overlay

```bash
sudo systemctl stop relay-bridge
relay-bridge register
sudo systemctl start relay-bridge
```

This publishes a SHIP token containing your bridge endpoint and identity. The overlay directory indexes it, and other bridges discover you on startup.

### Step 4: Verify

```bash
relay-bridge status
```

The Overlay section should show:
- Directory: reachable with topic/entry counts
- Registered: your mesh topic and SHIP txid

Other bridges will find you via overlay discovery on their next restart.

## For New Bridge Operators

Follow the standard setup:

1. `relay-bridge init`
2. Fund your bridge address
3. `relay-bridge fund <rawTxHex>`
4. `relay-bridge register`

Registration automatically uses the overlay. No additional configuration needed if the overlay runs locally on port 3360.

## Configuration

| Config key | Default | Description |
|---|---|---|
| `overlayUrl` | `http://127.0.0.1:3360` | URL of the overlay directory node |

## Deregistration

```bash
sudo systemctl stop relay-bridge
relay-bridge deregister
sudo systemctl start relay-bridge
```

This spends the SHIP token and notifies the overlay to remove the listing.

## Discovery Sources

On startup, the bridge populates its trusted peer set from:

1. Self pubkey + configured seed peers
2. Beacon backfill (historical beacon address scan)
3. Overlay discovery (query overlay for `mesh:bridge:*` entries)

All sources feed the same `registeredPubkeys` set used for handshake trust gating. Overlay-discovered peers are also added to the outbound connection list.

## Beacon Compatibility

Beacon registration and discovery still run during startup. Bridges registered via the old beacon method remain discoverable. The beacon path will be retired in a future release after all bridges have migrated to overlay registration.
