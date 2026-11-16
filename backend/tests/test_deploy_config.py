"""Guard tests for the ECR build/pull deployment configuration.

These are static, offline checks on the deployment artifacts — the compose file,
the deploy script, the Dockerfile, the entrypoint and the build workflow. They
assert the invariants the ECR migration must hold and must not break:

  * the app image is PULLED from ECR, never built on the host;
  * the deploy script fails safe (bad SHA, missing tooling, arch mismatch) and
    never prunes images or deploys an arbitrary tag;
  * the RDS CA bundle and verified-TLS wiring are preserved in the image;
  * migration 0094 runs only at container start, never at image-build time;
  * the workflow is manual, arm64, OIDC-authenticated, with no static secrets.

Deliberately dependency-free (stdlib only): the backend CI job installs
backend/requirements.txt, which does not include PyYAML, so these parse the
files as text rather than as YAML.
"""

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

COMPOSE = (REPO / "deploy" / "docker-compose.yml").read_text(encoding="utf-8")
REDEPLOY = (REPO / "deploy" / "redeploy.sh").read_text(encoding="utf-8")
DOCKERFILE = (REPO / "Dockerfile").read_text(encoding="utf-8")
ENTRYPOINT = (REPO / "deploy" / "docker-entrypoint.sh").read_text(encoding="utf-8")
WORKFLOW = (REPO / ".github" / "workflows" / "build-image.yml").read_text(encoding="utf-8")

ECR = "754549530476.dkr.ecr.ap-south-1.amazonaws.com"
REPO_NAME = "jackpotsworld"


# --------------------------------------------------------------------------
# docker-compose.yml
# --------------------------------------------------------------------------
def test_compose_app_uses_ecr_image_not_local_build():
    # The app service is pulled via APP_IMAGE, and the required-value guard is kept.
    assert "image: ${APP_IMAGE" in COMPOSE
    assert "${APP_IMAGE:?" in COMPOSE, "APP_IMAGE must be a required (:?) variable"
    # No `build:` key anywhere: the host must never build.
    assert re.search(r"^\s*build:", COMPOSE, re.M) is None, "compose must not define a build: section"


def test_compose_preserves_application_environment():
    for needle in (
        'DEPLOYED: "true"',
        'DEBUG: "false"',
        'OTP_DEV_ECHO: "false"',
        "REDIS_URL: redis://redis:6379/0",
        'FORWARDED_ALLOW_IPS: "*"',
        "APP_COMMIT: ${APP_COMMIT",
    ):
        assert needle in COMPOSE, f"compose must preserve {needle!r}"


def test_compose_preserves_redis_caddy_health_and_volumes():
    assert "image: redis:7-alpine" in COMPOSE
    assert "image: caddy:2" in COMPOSE
    assert "/api/health" in COMPOSE, "app healthcheck must be preserved"
    for vol in ("app_uploads:", "caddy_data:", "caddy_config:"):
        assert vol in COMPOSE, f"named volume {vol!r} must be preserved"


# --------------------------------------------------------------------------
# redeploy.sh
# --------------------------------------------------------------------------
def test_redeploy_pulls_and_does_not_build():
    assert "aws ecr get-login-password" in REDEPLOY, "must log in to ECR"
    assert "pull app" in REDEPLOY, "must pull the app image"
    assert "up -d --remove-orphans" in REDEPLOY, "must start without building"
    # No active build commands (comments may mention the word 'build').
    assert "up -d --build" not in REDEPLOY
    assert re.search(r"^\s*docker compose .* build app", REDEPLOY, re.M) is None


def test_redeploy_is_fail_safe_on_arch_and_config():
    # Arch guard.
    assert "uname -m" in REDEPLOY
    assert "Architecture" in REDEPLOY
    assert "does not match host" in REDEPLOY
    # Missing-tooling guard (AWS CLI).
    assert re.search(r"command -v aws", REDEPLOY), "must check the AWS CLI is present"
    # A failed pull aborts rather than deploying stale code.
    assert "Pull failed for ${APP_IMAGE}" in REDEPLOY


def test_redeploy_cannot_deploy_an_arbitrary_tag():
    # The tag is the resolved commit SHA, shape-guarded, and APP_IMAGE is
    # overwritten (exported) from hard-coded registry constants.
    assert "^[0-9a-f]{40}$" in REDEPLOY, "the deployed SHA must be shape-checked"
    assert "is not a 40-character commit SHA" in REDEPLOY
    assert f'readonly ECR_REGISTRY="{ECR}"' in REDEPLOY
    assert f'readonly ECR_REPOSITORY="{REPO_NAME}"' in REDEPLOY
    assert 'export APP_IMAGE="${ECR_REGISTRY}/${ECR_REPOSITORY}:${AFTER_SHA}"' in REDEPLOY


def test_redeploy_preserves_rollback_and_never_prunes():
    assert "ROLLBACK_IMAGE" in REDEPLOY, "must capture a rollback image"
    for pruner in ("docker image prune", "docker system prune", "prune -f", "image rm", "rmi "):
        assert pruner not in REDEPLOY, f"deploy script must never auto-prune ({pruner!r})"


# --------------------------------------------------------------------------
# Dockerfile + entrypoint
# --------------------------------------------------------------------------
def test_dockerfile_keeps_rds_bundle_and_builds_no_migration():
    assert "COPY deploy/certs/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem" in DOCKERFILE
    assert "/etc/ssl/certs/rds-global-bundle.pem" in DOCKERFILE
    # No migration is RUN at build time (a comment may still mention alembic).
    assert re.search(r"^\s*RUN\s+.*alembic", DOCKERFILE, re.M) is None


def test_entrypoint_runs_migration_at_startup():
    assert "alembic upgrade head" in ENTRYPOINT, "0094 runs at container start"


# --------------------------------------------------------------------------
# .github/workflows/build-image.yml
# --------------------------------------------------------------------------
def test_workflow_is_manual_arm64_oidc_and_pushes_sha_tag():
    assert "workflow_dispatch" in WORKFLOW, "manual trigger"
    assert "id-token: write" in WORKFLOW, "OIDC token permission"
    assert "linux/arm64" in WORKFLOW, "single-platform arm64"
    assert "aws-actions/configure-aws-credentials" in WORKFLOW
    assert "aws-actions/amazon-ecr-login" in WORKFLOW
    assert "push: true" in WORKFLOW
    assert "steps.sha.outputs.sha" in WORKFLOW, "immutable commit-SHA tag"
    assert ECR in WORKFLOW and REPO_NAME in WORKFLOW


def test_workflow_has_no_static_secrets_and_no_migrations():
    lowered = WORKFLOW.lower()
    assert "aws_secret_access_key" not in lowered
    assert "aws-access-key-id" not in lowered
    assert "aws_access_key_id" not in lowered
    # Build only: no tests, no migrations run in the workflow.
    assert "alembic" not in lowered
    assert "pytest" not in lowered


def test_workflow_default_ref_is_main_not_a_pinned_sha():
    # After PR #48 merges main advances, so the input must default to the branch,
    # not the frozen release SHA.
    assert "default: main" in WORKFLOW, "the git_ref input must default to main"
    assert "a8de672322560a86d4978ff6ea0afc4876378ace" not in WORKFLOW, \
        "the old hard-coded release SHA must not remain in the workflow"


def test_workflow_rejects_commits_not_on_main():
    # An explicit ancestry gate against origin/main, before any AWS/publish step.
    assert "merge-base --is-ancestor" in WORKFLOW, "must verify the commit is on main"
    assert "origin main" in WORKFLOW, "must fetch origin/main for the ancestry check"
    assert "not reachable from origin/main" in WORKFLOW, "must fail closed with a clear message"


def test_workflow_actions_are_sha_pinned_with_version_comments():
    # Every external action must pin a full 40-char commit SHA and carry a
    # readable version comment, e.g. `uses: owner/action@<40-hex> # v1.2.3`.
    uses = re.findall(r"^\s*uses:\s*(.+?)\s*$", WORKFLOW, re.M)
    assert uses, "workflow must declare external actions"
    assert len(uses) == 6, f"expected 6 external actions, found {len(uses)}: {uses}"
    pin_re = re.compile(r"^[^@\s]+/[^@\s]+@[0-9a-f]{40}\s+#\s*v?\d")
    for ref in uses:
        assert pin_re.match(ref), f"action not SHA-pinned with a version comment: {ref!r}"
    # A moving major/minor tag (e.g. @v4 or @v4.4.0) must not be used as the ref.
    assert not re.search(r"^\s*uses:\s*[^@\s]+@v?\d+(\.\d+)*\s*$", WORKFLOW, re.M), \
        "no action may be pinned to a mutable tag"


def test_workflow_retains_full_history_checkout():
    # The origin/main ancestry check needs full history to compute merge-base.
    assert "fetch-depth: 0" in WORKFLOW


def test_workflow_ancestry_check_precedes_aws_credentials():
    anc = WORKFLOW.find("Verify the commit is reachable from origin/main")
    aws = WORKFLOW.find("Configure AWS credentials")
    assert anc != -1 and aws != -1, "both steps must be present"
    assert anc < aws, "the origin/main ancestry gate must run before AWS credentials are configured"


if __name__ == "__main__":
    # Allow running directly (python backend/tests/test_deploy_config.py) without pytest.
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    raise SystemExit(1 if failures else 0)
