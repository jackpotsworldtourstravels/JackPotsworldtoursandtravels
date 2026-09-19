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
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxcb1 \
 && rm -rf /var/lib/apt/lists/*

# Requirements first so a code-only change doesn't reinstall the dependency tree.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend ./backend
COPY frontend ./frontend
COPY deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh
RUN chmod +x ./deploy/docker-entrypoint.sh && mkdir -p /app/uploads

# Booking documents (passport/visa scans) land here. On a host without a
# persistent volume this directory is wiped on every restart — mount a volume
# at /app/uploads, or point UPLOAD_ROOT at one, before real customer uploads.
ENV UPLOAD_ROOT=/app/uploads

WORKDIR /app/backend
EXPOSE 8000
CMD ["/app/deploy/docker-entrypoint.sh"]
