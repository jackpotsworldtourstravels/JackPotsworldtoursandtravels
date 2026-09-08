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

[[ ${EUID} -eq 0 ]] || fail "Run this with sudo — it installs software and writes to /etc."

readonly CONF=/etc/coturn/turnserver.conf
readonly REALM="${TURN_REALM:-jackpotsworldtours.com}"
#: Pinned rather than :latest — a TURN server that silently changes version
#: under a running deployment is not something anyone would notice until a call
#: failed.
readonly COTURN_IMAGE="coturn/coturn:4.6.2-alpine"

#: The relay port range. 41 ports, which is 41 simultaneous relayed streams —
#: far beyond what a support desk with a handful of agents will ever use, and
#: deliberately small because every port in this range has to be opened in the
#: security group by hand. Widen both together or not at all.
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
# HOW COTURN GETS ONTO THIS BOX
# Amazon Linux 2023 does not package coturn — `dnf install coturn` fails with
# "Unable to find a match", which is how this script first met production. EPEL
# is not a supported answer on AL2023 and building from source puts a compiler
# toolchain on a web server for one binary.
#
# Docker is. This deployment already runs the application under Docker Compose,
# so the engine is here, it is already how everything else on this box is
# started and restarted, and a container sidesteps the distribution question
# entirely.
#
# --network host IS REQUIRED, not a shortcut. coturn allocates relay ports
# dynamically across the whole min-port..max-port range and puts the addresses
# it picked inside the STUN/TURN payload. Published port mappings would rewrite
# the outside of the packet and not the inside, so the candidates it advertises
# would point somewhere the traffic does not arrive. Host networking is the
# documented way to run coturn in a container for exactly this reason.
step "Installing coturn"
INSTALL_MODE=""
if command -v turnserver >/dev/null 2>&1; then
  INSTALL_MODE="native"
  ok "already installed natively ($(turnserver -o --version 2>&1 | head -1))"
else
  if command -v dnf >/dev/null 2>&1 && dnf -q list coturn >/dev/null 2>&1; then
    dnf install -y coturn >/dev/null && INSTALL_MODE="native"
  elif command -v yum >/dev/null 2>&1 && yum -q list coturn >/dev/null 2>&1; then
    yum install -y coturn >/dev/null && INSTALL_MODE="native"
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y coturn >/dev/null && INSTALL_MODE="native"
  fi

  if [[ -z "${INSTALL_MODE}" ]]; then
    if ! command -v docker >/dev/null 2>&1; then
      fail "No coturn package for this distribution, and no docker to fall back on.
       Install docker, or install coturn by hand, then re-run."
    fi
    info "no coturn package for this distribution — using the official image"
    docker pull "${COTURN_IMAGE}" >/dev/null
    INSTALL_MODE="docker"
  fi
  ok "installed (${INSTALL_MODE})"
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
# systemd collects syslog; a container does not. Inside Docker the log has to
# go to stdout or `docker logs coturn` — which this script tells you to read
# when something is wrong — shows nothing at all.
if [[ "${INSTALL_MODE}" == "docker" ]]; then
  LOG_DIRECTIVE="log-file=stdout"
else
  LOG_DIRECTIVE="syslog"
fi

step "Writing ${CONF}"
mkdir -p "$(dirname "${CONF}")"
[[ -f "${CONF}" ]] && cp "${CONF}" "${CONF}.bak.$(date +%s)"

cat > "${CONF}" <<EOF
# Managed by deploy/setup-coturn.sh — CR-10 voice calls.
# Re-running that script rewrites this file and keeps the existing secret.

listening-port=3478

# NO TLS LISTENER, DELIBERATELY. turns: on 443 is genuinely useful — it is what
# gets through a corporate firewall that blocks UDP and inspects everything else
# — but it needs a certificate for a name that resolves to THIS host, which is
# its own DNS and renewal story. Configuring the port without a certificate
# makes coturn log errors about a listener it cannot open on every start, which
# is noise that trains you to ignore its log.
#
# To add it later: point a name (turn.jackpotsworldtours.com) at this host, get
# a certificate, then add cert=/pkey=/tls-listening-port=443 here and a
# turns:...:443?transport=tcp entry to TURN_URLS.
no-tls
no-dtls

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

# One relay session should not be able to saturate the box.
user-quota=12
total-quota=100
max-bps=128000

${LOG_DIRECTIVE}
pidfile=/run/turnserver.pid
EOF
# 644, not 640: the container runs coturn as its own uid and a
# root-only file is unreadable through the bind mount. The secret
# inside is the reason for 640 in the first place, so the directory
# stays restricted instead.
chmod 644 "${CONF}"
chmod 750 "$(dirname "${CONF}")"
ok "written"

# ---------------------------------------------------------------------------
# 5. Start
# ---------------------------------------------------------------------------
step "Starting coturn"
if [[ "${INSTALL_MODE}" == "native" ]]; then
  for envfile in /etc/sysconfig/coturn /etc/default/coturn; do
    [[ -f "${envfile}" ]] && sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' "${envfile}" || true
  done
  systemctl enable coturn >/dev/null 2>&1 || true
  systemctl restart coturn
  sleep 2
  systemctl is-active --quiet coturn \
    || fail "coturn did not start. Check: journalctl -u coturn -n 50"
else
  # `--restart unless-stopped` so it survives a reboot, matching how the rest of
  # this stack is kept alive. The config is bind-mounted read-only: re-running
  # this script rewrites the file and restarts the container, and nothing inside
  # it can edit its own configuration.
  #
  # `-n` IS LOAD-BEARING. Passing arguments here replaces the image's default
  # CMD, which is where its own `-n` lived — without it turnserver forks into
  # the background, the foreground process exits, and Docker declares the
  # container finished. It would look like coturn "started and stopped" with
  # nothing wrong in the log.
  docker rm -f coturn >/dev/null 2>&1 || true
  docker run -d \
    --name coturn \
    --network host \
    --restart unless-stopped \
    -v "${CONF}:/etc/coturn/turnserver.conf:ro" \
    "${COTURN_IMAGE}" \
    -n -c /etc/coturn/turnserver.conf >/dev/null
  sleep 3
  if ! docker ps --filter name=coturn --filter status=running -q | grep -q .; then
    printf '\n--- coturn container log ---\n' >&2
    docker logs coturn 2>&1 | tail -30 >&2
    fail "the coturn container did not stay up (log above)."
  fi
fi
ok "running (${INSTALL_MODE})"

if ss -lnu 2>/dev/null | grep -q ':3478'; then
  ok "listening on UDP 3478"
else
  if [[ "${INSTALL_MODE}" == "docker" ]]; then
    warn "nothing is listening on UDP 3478 — check: docker logs coturn"
  else
    warn "nothing is listening on UDP 3478 — check: journalctl -u coturn -n 50"
  fi
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

    Source 0.0.0.0/0 on all three — customers connect from anywhere.
    Nothing listens on 5349: TLS is off until a certificate exists (see the
    note in ${CONF}).

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
