#!/bin/sh
# Init wrapper for the mint's Fiber node.
#
# The node must announce this server's PUBLIC IP so payments can route to it. You do NOT set that
# by hand — a small init step writes the server's own public IP to /fiber/public_ip, and this reads
# it. It also generates the node's key + key-password once. All of it persists in the fnn volume.
set -eu

BASE=/fiber
CONFIG="$BASE/config.yml"
mkdir -p "$BASE/ckb"

# Key-encryption password: use the env override if given, else generate one and persist it, so the
# operator never has to supply it. (The fnn image's own entrypoint requires this to be exported.)
if [ -z "${FIBER_SECRET_KEY_PASSWORD:-}" ]; then
  PWFILE="$BASE/secret_key.password"
  [ -f "$PWFILE" ] || od -An -N24 -tx1 /dev/urandom | tr -d ' \n' > "$PWFILE"
  FIBER_SECRET_KEY_PASSWORD="$(cat "$PWFILE")"
  export FIBER_SECRET_KEY_PASSWORD
fi

# The public IP: env override, else the value the ipinit step detected for this server.
IP="${PUBLIC_IP:-}"
if [ -z "$IP" ] && [ -f "$BASE/public_ip" ]; then
  IP="$(tr -d '[:space:]' < "$BASE/public_ip")"
fi

# One-time CKB funding key (plaintext hex; fnn encrypts it in place on first read).
if [ ! -f "$BASE/ckb/key" ]; then
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$BASE/ckb/key"
  echo "[fnn-init] generated a new CKB key — back up the fnn data volume" >&2
fi

# One-time config from the image's bundled testnet template (RPC already loopback, CKB already the
# public testnet RPC, RUSD already whitelisted); add only the announce deltas.
if [ ! -f "$CONFIG" ]; then
  cp /usr/local/share/fiber/config/testnet/config.yml "$CONFIG"
  if [ -z "$IP" ]; then
    echo "[fnn-init] WARNING: could not determine this server's public IP — the node will not be" >&2
    echo "[fnn-init]          routable. Set PUBLIC_IP in .env if auto-detection is blocked." >&2
    IP=0.0.0.0
  fi
  sed -i "s|^fiber:|fiber:\n  auto_announce_node: true\n  announce_private_addr: false\n  announced_node_name: \"${MINT_NODE_NAME:-fibernuts-mint}\"|" "$CONFIG"
  sed -i "s|^\(  announced_addrs:\)|\1\n    - \"/ip4/${IP}/tcp/8228\"|" "$CONFIG"
  echo "[fnn-init] announcing /ip4/${IP}/tcp/8228" >&2
fi

exec /usr/local/bin/docker-entrypoint.sh fnn
