#!/usr/bin/env bash
#
# The deployment script. Run it on the EC2 instance:
#
#     cd ~/JackPotsworldtoursandtravels && bash deploy/redeploy.sh
#
# It pulls the latest code, pulls the prebuilt image from Amazon ECR (it does
# NOT build locally), restarts the stack and waits for the app to report
# healthy. Nothing else deploys this application — if a document tells you to
# run something different, that document is out of date.
#
# WHAT THIS REPLACED, AND WHY IT MATTERED
# The previous version of this file deployed a pre-Docker architecture that no
# longer exists, from a hard-coded absolute path that is not where this
# repository lives. The live stack is a Docker image behind Caddy with the
# database in RDS. Run against the current server that script would either die
# on its first line or — worse, had a stale checkout still been sitting at that
# path — pull old code and migrate the production database from it.
#
# Hence the first rule here: **the repository path is derived from this
# script's own location and is never hard-coded.** A deploy script cannot then
# point at a checkout it is not part of.
#
# WHY PULL, NOT BUILD
# The image is built off-host by GitHub Actions and pushed to Amazon ECR with an
# immutable, commit-SHA tag. This script pulls exactly the tag for the commit it
# just checked out, so "deployed" and "running" cannot drift: there is no local
# build to go stale, and a tag that was never pushed fails the pull here rather
# than silently serving old code.
#
set -euo pipefail

# --------------------------------------------------------------------------
# Logging
# --------------------------------------------------------------------------
readonly RED=$'\033[0;31m' GREEN=$'\033[0;32m' YELLOW=$'\033[0;33m' BOLD=$'\033[1m' OFF=$'\033[0m'

step()  { printf '\n%s==> %s%s\n' "${BOLD}" "$*" "${OFF}"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s✓ %s%s\n' "${GREEN}" "$*" "${OFF}"; }
warn()  { printf '    %s! %s%s\n' "${YELLOW}" "$*" "${OFF}"; }
fail()  { printf '\n%s✗ %s%s\n\n' "${RED}" "$*" "${OFF}" >&2; exit 1; }

# Any unexpected non-zero exit lands here, so a failure is never silent.
trap 'fail "Deployment aborted at line ${LINENO}. Nothing further was run; the previous containers are still up."' ERR

readonly REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly COMPOSE_DIR="${REPO_DIR}/deploy"
readonly HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

# The image to deploy lives in Amazon ECR. These are hard-coded constants, NOT
# read from the environment, so this script cannot be pointed at an arbitrary
# registry or tag. The tag is derived below from the deployed commit SHA.
readonly ECR_REGISTRY="754549530476.dkr.ecr.ap-south-1.amazonaws.com"
readonly ECR_REPOSITORY="jackpotsworld"
readonly AWS_REGION="${AWS_REGION:-ap-south-1}"

printf '%s\n' "${BOLD}JackPots World — production redeploy${OFF}"
info "repository: ${REPO_DIR}"

# --------------------------------------------------------------------------
# 1. Verify the repository path
# --------------------------------------------------------------------------
# Derived from this script's own location rather than hard-coded, which is what
# stops the class of bug that made the rewrite necessary: the script cannot
# point at a directory it is not in.
step "1/6  Verifying the repository"

[[ -d "${REPO_DIR}/.git" ]]                  || fail "${REPO_DIR} is not a git checkout."
[[ -f "${REPO_DIR}/Dockerfile" ]]            || fail "No Dockerfile at ${REPO_DIR}. Wrong directory?"
[[ -f "${COMPOSE_DIR}/docker-compose.yml" ]] || fail "No deploy/docker-compose.yml. Wrong directory?"
ok "checkout, Dockerfile and compose file present"

command -v docker >/dev/null || fail "docker is not installed on this host."
docker compose version >/dev/null 2>&1 \
  || fail "The docker compose plugin is missing. This stack needs 'docker compose', not 'docker-compose'."
command -v aws >/dev/null || fail "The AWS CLI is not installed on this host. It is needed to log in to ECR."
ok "docker, the compose plugin and the AWS CLI are available"

# Both are gitignored and must exist on the server. Missing backend/.env means
# the container starts with no DATABASE_URL and migrates nothing; missing
# deploy/.env means Caddy cannot work out which certificate to request.
[[ -f "${REPO_DIR}/backend/.env" ]] \
  || fail "backend/.env is missing. The app needs DATABASE_URL, JWT_SECRET_KEY and the S3 settings. See docs/AWS_DEPLOYMENT.md."
[[ -f "${COMPOSE_DIR}/.env" ]] \
  || fail "deploy/.env is missing. Caddy needs SITE_DOMAIN in it to request a certificate."
ok "backend/.env and deploy/.env present"

# Uncommitted changes on a production host mean somebody edited live code. The
# pull below would either clobber it or refuse, so say so now.
if [[ -n "$(git -C "${REPO_DIR}" status --porcelain)" ]]; then
    warn "The working tree has uncommitted changes:"
    git -C "${REPO_DIR}" status --short | sed 's/^/      /'
    warn "The pull may refuse or overwrite them."
fi

readonly BEFORE_SHA="$(git -C "${REPO_DIR}" rev-parse HEAD)"
info "currently deployed: ${BEFORE_SHA:0:7}  $(git -C "${REPO_DIR}" log -1 --format=%s)"

# --------------------------------------------------------------------------
# 2. Pull the latest code
# --------------------------------------------------------------------------
step "2/6  Pulling the latest code"

git -C "${REPO_DIR}" pull --ff-only \
  || fail "git pull failed. If it reports divergent branches, this host has commits that were never pushed — resolve that by hand rather than forcing."

readonly AFTER_SHA="$(git -C "${REPO_DIR}" rev-parse HEAD)"
# Handed to the container so /api/version can report it. Exported before
# the build, because compose reads the environment at `up` time.
export APP_COMMIT="${AFTER_SHA}"
if [[ "${BEFORE_SHA}" == "${AFTER_SHA}" ]]; then
    info "already up to date at ${AFTER_SHA:0:7} — rebuilding and restarting anyway"
else
    ok "updated ${BEFORE_SHA:0:7} -> ${AFTER_SHA:0:7}"
    git -C "${REPO_DIR}" log --oneline "${BEFORE_SHA}..${AFTER_SHA}" | sed 's/^/      /'
fi

# --------------------------------------------------------------------------
# 3. Pull the prebuilt image from ECR (no local build)
# --------------------------------------------------------------------------
step "3/6  Pulling the prebuilt image from ECR"

# The tag is the deployed commit SHA, resolved from the checkout above — never
# an inherited APP_IMAGE, a branch name or "latest". Guard the shape so a
# malformed value can never become an image reference.
if [[ ! "${AFTER_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
    fail "Refusing to deploy: '${AFTER_SHA}' is not a 40-character commit SHA."
fi
# Overwrite (not default) any inherited APP_IMAGE, so the environment cannot
# redirect this deploy to an arbitrary image. Exported for the compose calls.
export APP_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:${AFTER_SHA}"
info "image: ${APP_IMAGE}"

# Capture the image currently running, BEFORE anything changes, as the rollback
# target. On the first ECR deploy this is the local 'deploy-app' image — keep
# it. This script never prunes images.
readonly ROLLBACK_IMAGE="$(docker inspect --format '{{.Config.Image}}' deploy-app-1 2>/dev/null || echo 'none (first ECR deploy)')"
info "rollback image (currently running): ${ROLLBACK_IMAGE}"

# Authenticate docker to ECR using the instance role — no stored credentials.
aws ecr get-login-password --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${ECR_REGISTRY}" \
  || fail "ECR login failed. Does the instance role grant ecr:GetAuthorizationToken, and can the host reach ECR?"

# Pull exactly this commit's image. A tag that was never built/pushed fails
# HERE — the stack is left untouched rather than redeployed from stale code.
docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" pull app \
  || fail "Pull failed for ${APP_IMAGE}. Build it first with the build-image workflow, or check ECR connectivity."

# An amd64 image on this arm64 host boots to a cryptic 'exec format error'.
# Fail here instead, by comparing the pulled image's architecture to the host's.
img_arch="$(docker image inspect "${APP_IMAGE}" --format '{{.Architecture}}' 2>/dev/null || echo unknown)"
host_arch="$(uname -m)"
case "${img_arch}@${host_arch}" in
    arm64@aarch64|amd64@x86_64)
        ok "image architecture ${img_arch} matches host ${host_arch}" ;;
    *)
        fail "Image architecture '${img_arch}' does not match host '${host_arch}'. Rebuild for the host platform (linux/arm64)." ;;
esac

# --------------------------------------------------------------------------
# 4. Start / update the containers (no build — the image is already pulled)
# --------------------------------------------------------------------------
# NOT --build. compose starts the exact image pulled above. The app runs
# `alembic upgrade head` on start, so migration 0094 runs HERE, during this
# approved deploy, and never at image-build time.
step "4/6  Starting the containers"
info "the app runs migrations on start, so the first moments are expected to be unhealthy"

docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" up -d --remove-orphans \
  || fail "docker compose up failed. Check 'docker compose logs' in ${COMPOSE_DIR}."
ok "containers started"

# --------------------------------------------------------------------------
# 5. Wait for the application to become healthy
# --------------------------------------------------------------------------
# The compose healthcheck already polls /api/health; this waits on its verdict
# rather than inventing a second definition of healthy. start_period is 90s
# because the entrypoint runs `alembic upgrade head` before serving.
step "5/6  Waiting for the application to become healthy"
info "timeout ${HEALTH_TIMEOUT}s (override with HEALTH_TIMEOUT=...)"

container_id() {
    docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" ps -q app
}

cid="$(container_id)"
[[ -n "${cid}" ]] || fail "The app container is not running. Check 'docker compose logs app' in ${COMPOSE_DIR}."

deadline=$(( SECONDS + HEALTH_TIMEOUT ))
state=""
while (( SECONDS < deadline )); do
    state="$(docker inspect --format '{{.State.Health.Status}}' "${cid}" 2>/dev/null || echo unknown)"
    case "${state}" in
        healthy)
            ok "application is healthy"
            break
            ;;
        unhealthy)
            printf '\n'
            docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" logs --tail 40 app
            fail "The container reported unhealthy. Logs above. The most common causes are a bad DATABASE_URL in backend/.env and a failed migration."
            ;;
        *)
            printf '.'
            sleep 5
            ;;
    esac
done

if [[ "${state}" != "healthy" ]]; then
    printf '\n'
    docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" logs --tail 40 app
    fail "Timed out after ${HEALTH_TIMEOUT}s waiting for health. Logs above. If migrations are still running, re-run with HEALTH_TIMEOUT=300."
fi

# The migration lines the entrypoint prints, surfaced so a schema change is
# visible in the deploy output rather than only in the container log.
step "     Migrations reported by this boot"
docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" logs app 2>/dev/null \
  | grep -iE "running (upgrade|migrations)|alembic" | tail -15 | sed 's/^/      /' \
  || info "(no migration lines in this boot's log — the schema was already at head)"

# --------------------------------------------------------------------------
# 6. Deployment status
# --------------------------------------------------------------------------
step "6/6  Deployment status"

docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" ps

printf '\n%s' "${GREEN}"
printf 'Deployed successfully.\n'
printf '%s' "${OFF}"
printf '    commit   %s\n' "$(git -C "${REPO_DIR}" rev-parse HEAD)"
printf '    subject  %s\n' "$(git -C "${REPO_DIR}" log -1 --format=%s)"
printf '    health   healthy\n'
printf '\n'
info "Smoke-test before you call it done:"
info "  curl -fsS https://\${SITE_DOMAIN}/api/health"
info "  sign in to /admin/ and open Wallet & Top-ups -> Wallet Reconciliation"
info "  every merchant's drift must read 0.00"
printf '\n'
