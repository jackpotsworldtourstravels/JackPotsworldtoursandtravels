#!/usr/bin/env bash
#
# The deployment script. Run it on the EC2 instance:
#
#     cd ~/JackPotsworldtoursandtravels && bash deploy/redeploy.sh
#
# It pulls the latest code, pulls the prebuilt image from Amazon ECR (it does
# NOT build locally), applies database migrations as a separate one-off step
# (the serve-only app never migrates on boot), restarts the stack and waits for
# the app to report healthy. Nothing else deploys this application — if a
# document tells you to run something different, that document is out of date.
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
# NOTE: before step 4 the previous container is still running; from step 4 on it
# may already have been replaced. Hence the deliberately neutral wording.
trap 'fail "Deployment aborted at line ${LINENO}. Depending on how far it got, the previous container may still be running or may already have been replaced — check with docker compose ps before retrying."' ERR

readonly REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly COMPOSE_DIR="${REPO_DIR}/deploy"
readonly HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

# The image to deploy lives in Amazon ECR. These are hard-coded constants, NOT
# read from the environment, so this script cannot be pointed at an arbitrary
# registry or tag. The tag is derived below from the deployed commit SHA.
readonly ECR_REGISTRY="754549530476.dkr.ecr.ap-south-1.amazonaws.com"
readonly ECR_REPOSITORY="jackpotsworld"
readonly AWS_REGION="${AWS_REGION:-ap-south-1}"

# After a successful deploy + health check, record the just-deployed image in
# deploy/.env so ordinary `docker compose ps/logs/exec` keep working once this
# script exits (compose requires APP_IMAGE via `image: ${APP_IMAGE:?...}`).
# Atomic (write temp + rename); preserves SITE_DOMAIN and every other line and
# the file's permissions; replaces any existing APP_IMAGE line rather than
# duplicating it; never prints the file's contents. Best-effort: a hiccup here
# warns but never fails an already-successful deploy. A manual rollback still
# wins, because a shell `APP_IMAGE=... docker compose ...` overrides the .env file.
persist_app_image() {
    local env_file="${COMPOSE_DIR}/.env" tmp
    [[ -r "${env_file}" && -w "${COMPOSE_DIR}" ]] \
      || { warn "deploy/.env not writable; APP_IMAGE not persisted (export it for ad-hoc compose)"; return 0; }
    tmp="$(mktemp "${COMPOSE_DIR}/.env.tmp.XXXXXX")" \
      || { warn "mktemp failed; APP_IMAGE not persisted"; return 0; }
    # Match the original file's permissions on the replacement.
    chmod --reference="${env_file}" "${tmp}" 2>/dev/null || true
    # Keep every line except an existing APP_IMAGE assignment, then append the new
    # one. `|| true` so grep finding nothing to keep (exit 1) does not trip set -e.
    { grep -vE '^[[:space:]]*APP_IMAGE=' "${env_file}" || true; printf 'APP_IMAGE=%s\n' "${APP_IMAGE}"; } > "${tmp}" \
      || { rm -f "${tmp}"; warn "could not write temp env; APP_IMAGE not persisted"; return 0; }
    mv -f "${tmp}" "${env_file}" \
      || { rm -f "${tmp}"; warn "could not update deploy/.env; APP_IMAGE not persisted"; return 0; }
}

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
    info "already up to date at ${AFTER_SHA:0:7} — re-pulling and restarting anyway"
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

# Record the image currently running, BEFORE anything changes, as a MANUAL
# recovery target — this script does NOT roll back automatically. If the new
# container turns out unhealthy, an operator re-points APP_IMAGE at this value
# and runs `docker compose up -d` (see deploy/README.md). On the first ECR deploy
# this is the local 'deploy-app' image. This script never prunes images, so it
# stays available for that manual rollback.
readonly ROLLBACK_IMAGE="$(docker inspect --format '{{.Config.Image}}' deploy-app-1 2>/dev/null || echo 'none (first ECR deploy)')"
info "manual rollback target (NOT automatic): APP_IMAGE=${ROLLBACK_IMAGE}"

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
# 3b. Apply database migrations as a SEPARATE, explicit step (role separation)
# --------------------------------------------------------------------------
# The app container is SERVE-ONLY and never migrates on boot (see
# deploy/docker-entrypoint.sh). Migrations run HERE as a one-shot container,
# from the image just pulled, using the MIGRATION/owner credential — which is
# supplied ONLY to this step and is NEVER stored in backend/.env (the app's
# env_file), so the runtime app process never receives it. The credential comes
# from the protected, gitignored backend/.env.migration (or an already-exported
# MIGRATION_DATABASE_URL) and is forwarded with a bare `-e MIGRATION_DATABASE_URL`
# so its VALUE never appears on the command line (no leak via `ps`, shell tracing
# or logs). On a deployed host it is REQUIRED — we fail closed rather than fall
# back to the runtime DATABASE_URL. If migration fails, the app is NOT (re)started.
MIGRATION_ENV_FILE="${MIGRATION_ENV_FILE:-${REPO_DIR}/backend/.env.migration}"
if [[ -z "${MIGRATION_DATABASE_URL:-}" && -f "${MIGRATION_ENV_FILE}" ]]; then
  set -a; . "${MIGRATION_ENV_FILE}"; set +a       # load quietly; value is never echoed
fi
[[ -n "${MIGRATION_DATABASE_URL:-}" ]] \
  || fail "MIGRATION_DATABASE_URL is not set. A deployed migration needs the migration/owner credential. Put it in ${MIGRATION_ENV_FILE} (chmod 600, gitignored) or export it — it must NOT go in backend/.env (that env_file feeds the serve-only app container)."
export MIGRATION_DATABASE_URL
step "3b/6  Applying database migrations (separate step, migration role)"
info "one-off container from the pulled image; the serve-only app never migrates on boot"
docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" \
  run --rm --no-deps -e MIGRATION_DATABASE_URL --entrypoint /app/deploy/migrate.sh app \
  || fail "Database migration (alembic upgrade head) failed. Nothing was restarted — the previous version is still serving. Check the migration credential (${MIGRATION_ENV_FILE}) and the database."
ok "migrations applied"

# --------------------------------------------------------------------------
# 4. Start / update the containers (no build — the image is already pulled)
# --------------------------------------------------------------------------
# NOT --build. compose starts the exact image pulled above. The app is
# serve-only: migrations already ran in step 3b, so the container does not
# migrate on boot (role separation — the runtime DATABASE_URL need not hold DDL).
step "4/6  Starting the containers"
info "the app is serve-only (migrations ran in the separate step above)"

docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" up -d --remove-orphans \
  || fail "docker compose up failed. Check 'docker compose logs' in ${COMPOSE_DIR}."
ok "containers started"

# --------------------------------------------------------------------------
# 5. Wait for the application to become healthy
# --------------------------------------------------------------------------
# The compose healthcheck already polls /api/health; this waits on its verdict
# rather than inventing a second definition of healthy. start_period is 90s to
# absorb normal application boot (migrations already ran in step 3b).
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

# --------------------------------------------------------------------------
# Persist APP_IMAGE for post-deploy compose commands (only now — health passed)
# --------------------------------------------------------------------------
# Reached only after the health gate above succeeds (it fails/exits otherwise),
# so a FAILED deploy never overwrites the last known-good APP_IMAGE in deploy/.env.
persist_app_image
ok "recorded APP_IMAGE in deploy/.env (a manual 'APP_IMAGE=... docker compose' still overrides it)"

# Migrations ran in step 3b (the separate migration container), NOT on app boot.
# Surface the app's own serve-only confirmation so the deploy output shows the
# container did not migrate on start (role separation working as intended).
step "     Migration mode on this boot"
docker compose -f "${COMPOSE_DIR}/docker-compose.yml" --project-directory "${COMPOSE_DIR}" logs app 2>/dev/null \
  | grep -iE "serve-only: migrations|running 'alembic upgrade head'" | tail -5 | sed 's/^/      /' \
  || info "(app log did not report its migration mode; migrations ran in step 3b above)"

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
