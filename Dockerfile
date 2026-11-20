# One image that serves the whole product: the FastAPI API and the static
# frontend on a single origin. Same-origin is what the frontend already expects
# off localhost — see partner-shared.js, where API_BASE falls back to '' — so no
# CORS setup or separate static host is needed.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# OPENCV'S SYSTEM LIBRARIES, WITHOUT WHICH OCR_PROVIDER=local CANNOT RUN.
# rapidocr-onnxruntime pulls in opencv-python, which links against libGL, glib
# and libxcb. python:3.12-slim carries none of the three.
#
# THIS FAILS SILENTLY, WHICH IS WHY IT REACHED PRODUCTION. local_provider.py
# imports rapidocr LAZILY and turns an import failure into OCRMisconfigured, so
# without these the image builds, the container boots, `alembic upgrade head`
# runs, the health check passes and redeploy.sh exits 0 -- and the only thing
# that does not work is an operator scanning a passport. Production ran that
# way with OCR_PROVIDER=local set against an image that could not `import cv2`.
#
# The three were confirmed sufficient and minimal against the built image on
# the production host: with them, cv2 5.0.0, pymupdf and rapidocr all import;
# without them, cv2 dies on libxcb.so.1.
#
# Ahead of the requirements COPY on purpose, so a dependency change does not
# reinstall them and this layer stays cached.
#
# SECURITY (fix/security-refresh-debian-base): also refresh the Debian "Trixie"
# (deb13) base packages so a rebuild picks up security fixes published after
# python:3.12-slim was tagged. `apt-get upgrade` pulls current Trixie security
# updates for every installed package (glibc, libxml2, zlib, ...). zlib1g is then
# installed explicitly and its version is asserted against the DSA-6613-1 fix for
# CVE-2026-85091; the build FAILS CLOSED if it is older, so a regressed base can
# never ship. Debian official repositories only -- no Sid/Forky, no version
# pinning that would swap in an untested system library.
RUN set -eux; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxcb1 zlib1g; \
    ZLIB_FIXED='1:1.3.dfsg+really1.3.1-1+deb13u1'; \
    ZLIB_HAVE="$(dpkg-query -W -f='${Version}' zlib1g)"; \
    echo "zlib1g installed=${ZLIB_HAVE} required>=${ZLIB_FIXED}"; \
    if ! dpkg --compare-versions "${ZLIB_HAVE}" ge "${ZLIB_FIXED}"; then \
        echo "FATAL: zlib1g ${ZLIB_HAVE} is below the DSA-6613-1 fix ${ZLIB_FIXED} (CVE-2026-85091)" >&2; \
        exit 1; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Requirements first so a code-only change doesn't reinstall the dependency tree.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend ./backend
COPY frontend ./frontend
COPY deploy/certs/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
RUN chmod 0644 /etc/ssl/certs/rds-global-bundle.pem
COPY deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh
# The explicit, separate migration step (database role separation). Run with the
# migration role; the serve-only app container never invokes it. See deploy/migrate.sh.
COPY deploy/migrate.sh ./deploy/migrate.sh
# The server process runs as this unprivileged account, not root. The container
# still STARTS as root, and only so docker-entrypoint.sh can repair the ownership
# of the uploads volume (a volume created by an older, root-running image is
# root-owned) before dropping privileges with setpriv. Nothing that serves a
# request ever holds root.
RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home app
ENV HOME=/home/app

RUN chmod +x ./deploy/docker-entrypoint.sh ./deploy/migrate.sh && mkdir -p /app/uploads && chown app:app /app/uploads

# Booking documents (passport/visa scans) land here. On a host without a
# persistent volume this directory is wiped on every restart — mount a volume
# at /app/uploads, or point UPLOAD_ROOT at one, before real customer uploads.
ENV UPLOAD_ROOT=/app/uploads

WORKDIR /app/backend
EXPOSE 8000
CMD ["/app/deploy/docker-entrypoint.sh"]
