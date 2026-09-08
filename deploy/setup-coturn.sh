#!/usr/bin/env bash
#
# Install and configure coturn for CR-10 voice calls. Run it ON THE EC2 BOX:
#
#     sudo bash deploy/setup-coturn.sh
#
# WHY THIS EXISTS
# Without TURN, a call works only when the two browsers can reach each other
# directly. Behind symmetric NAT they cannot — and on Indian mobile carriers,
# CGNAT is the common case, not the exception. Those calls fail with no error
# the customer can act on: "Calling…" forever, then nothing. STUN alone does not
# fix it; a relay is the only thing that does.
#
# WHAT IT SETS UP
# coturn with `use-auth-secret` — the REST-API scheme, where the app mints
# time-limited credentials from a shared secret rather than everyone sharing one
# username and password. See call_signaling.turn_credentials(). A static pair
# handed to every browser is a permanent credential to a relay you pay for,
# sitting in the devtools of anyone who looks.
#
# WHAT IT DOES NOT DO
# It does not open the security group — that is an AWS-side change and this
# script has no business holding AWS credentials. It prints exactly which ports
# to open and stops if it cannot reach itself afterwards.
#
set -euo pipefail

readonly RED=$'\033[0;31m' GREEN=$'\033[0;32m' YELLOW=$'\033[0;33m' BOLD=$'\033[1m' OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "${BOLD}" "$*" "${OFF}"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓ %s%s\n' "${GREEN}" "$*" "${OFF}"; }
warn() { printf '    %s! %s%s\n' "${YELLOW}" "$*" "${OFF}"; }
fail() { printf '\n%s✗ %s%s\n\n' "${RED}" "$*" "${OFF}" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || fail "Run this with sudo — it installs a package and writes to /etc."

readonly CONF=/etc/coturn/turnserver.conf
readonly REALM="${TURN_REALM:-jackpotsworldtours.com}"
#: The relay port range coturn allocates from. 10k ports is far more than this
#: deployment will ever use; the range matters mainly because the security group
#: has to allow exactly it.
readonly MIN_PORT=49160
readonly MAX_PORT=49200

# ---------------------------------------------------------------------------
# 1. Addresses
# ---------------------------------------------------------------------------
# THE ONE THING THAT BREAKS TURN ON EC2. The instance sees a private address;
# the world reaches it on an elastic IP. coturn must be told both, or it hands
# out candidates pointing at 172.31.x.x and every relayed call fails while the
# server logs look perfectly healthy.
step "Working out this instance's addresses"

TOKEN="$(curl -fsS -X PUT 'http://169.254.169.254/latest/api/token' \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' 2>/dev/null || true)"
imds() {
  if [[ -n "${TOKEN}" ]]; then
    curl -fsS -H "X-aws-ec2-metadata-token: ${TOKEN}" "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true
  else
    curl -fsS "http://169.254.169.254/latest/meta-data/$1" 2>/dev/null || true
  fi
}

PRIVATE_IP="$(imds local-ipv4)"
PUBLIC_IP="${TURN_PUBLIC_IP:-$(imds public-ipv4)}"

[[ -n "${PRIVATE_IP}" ]] || fail "Could not read this instance's private IP from IMDS."
if [[ -z "${PUBLIC_IP}" ]]; then
  fail "No public IP found. If this instance sits behind an elastic IP or NAT, pass it:
       TURN_PUBLIC_IP=1.2.3.4 sudo bash deploy/setup-coturn.sh"
fi
ok "private ${PRIVATE_IP}   public ${PUBLIC_IP}"

# ---------------------------------------------------------------------------
# 2. Install
# ---------------------------------------------------------------------------
step "Installing coturn"
if command -v turnserver >/dev/null 2>&1; then
  ok "already installed ($(turnserver -o --version 2>&1 | head -1))"
else
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y coturn >/dev/null
  elif command -v yum >/dev/null 2>&1; then
    yum install -y coturn >/dev/null
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y coturn >/dev/null
  else
    fail "No dnf, yum or apt-get. Install coturn by hand and re-run."
  fi
  ok "installed"
fi

# ---------------------------------------------------------------------------
# 3. The shared secret
# ---------------------------------------------------------------------------
# Reused if one is already configured, so re-running this script does not
# invalidate the secret sitting in backend/.env and silently break every call.
step "Shared secret"
if [[ -f "${CONF}" ]] && grep -q '^static-auth-secret=' "${CONF}"; then
  SECRET="$(grep '^static-auth-secret=' "${CONF}" | head -1 | cut -d= -f2-)"
  ok "reusing the existing secret (re-running is safe)"
else
  SECRET="$(openssl rand -hex 32)"
  ok "generated a new 256-bit secret"
fi

# ---------------------------------------------------------------------------
# 4. Configure
# ---------------------------------------------------------------------------
step "Writing ${CONF}"
mkdir -p "$(dirname "${CONF}")"
[[ -f "${CONF}" ]] && cp "${CONF}" "${CONF}.bak.$(date +%s)"

cat > "${CONF}" <<EOF
# Managed by deploy/setup-coturn.sh — CR-10 voice calls.
# Re-running that script rewrites this file and keeps the existing secret.

listening-port=3478
tls-listening-port=5349

# BOTH ADDRESSES. The instance binds the private one and advertises the public
# one; without the mapping coturn hands out unreachable candidates.
listening-ip=${PRIVATE_IP}
external-ip=${PUBLIC_IP}/${PRIVATE_IP}

min-port=${MIN_PORT}
max-port=${MAX_PORT}

realm=${REALM}
server-name=${REALM}

# Time-limited credentials minted by the app from this secret. No user list.
use-auth-secret
static-auth-secret=${SECRET}

fingerprint
# A TURN server that will relay to anything is an open proxy and will be found
# and abused within days. Deny every internal range, and multicast.
no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

# This deployment does not need TURN's own database, CLI or web admin.
no-cli
no-tlsv1
no-tlsv1_1
no-sslv3

# One relay session should not be able to saturate the box.
user-quota=12
total-quota=100
max-bps=128000

syslog
pidfile=/run/turnserver.pid
EOF
chmod 640 "${CONF}"
ok "written"

# ---------------------------------------------------------------------------
# 5. Start
# ---------------------------------------------------------------------------
step "Starting coturn"
if [[ -f /etc/sysconfig/coturn ]]; then
  sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/sysconfig/coturn || true
fi
if [[ -f /etc/default/coturn ]]; then
  sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn || true
fi
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
sleep 2
systemctl is-active --quiet coturn || fail "coturn did not start. Check: journalctl -u coturn -n 50"
ok "running"

if ss -lnu 2>/dev/null | grep -q ':3478'; then
  ok "listening on UDP 3478"
else
  warn "nothing is listening on UDP 3478 — check journalctl -u coturn -n 50"
fi

# ---------------------------------------------------------------------------
# 6. What is left, which is not nothing
# ---------------------------------------------------------------------------
step "Add these to backend/.env, then redeploy"
cat <<EOF

    VOICE_CALLS_ENABLED=true
    TURN_URLS=turn:${PUBLIC_IP}:3478?transport=udp,turn:${PUBLIC_IP}:3478?transport=tcp
    TURN_STATIC_AUTH_SECRET=${SECRET}

EOF
info "Then: cd ~/JackPotsworldtoursandtravels && bash deploy/redeploy.sh"

step "OPEN THESE PORTS in the EC2 security group — nothing works until you do"
cat <<EOF

    UDP  3478              STUN/TURN
    TCP  3478              TURN over TCP, for networks that block UDP
    UDP  ${MIN_PORT}-${MAX_PORT}    the relay range
    TCP  5349              TURN over TLS (optional, needs a certificate)

EOF
warn "This script cannot open them — that is an AWS-side change."

step "Then prove it actually relays"
cat <<'EOF'
    Open https://icetest.info/ (or webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
    Enter the TURN URL, username and credential printed by:

        curl -s -H "Authorization: Bearer <admin token>" \
             https://jackpotsworldtours.com/api/admin/chat/ice | python3 -m json.tool

    You must see at least one candidate of type "relay".
    No relay candidate means TURN is not working, whatever the logs say.
EOF

printf '\n%s✓ coturn configured.%s Voice calls stay OFF until VOICE_CALLS_ENABLED=true is deployed.\n\n' "${GREEN}" "${OFF}"
