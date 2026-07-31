# One image that serves the whole product: the FastAPI API and the static
# frontend on a single origin. Same-origin is what the frontend already expects
# off localhost — see partner-shared.js, where API_BASE falls back to '' — so no
# CORS setup or separate static host is needed.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

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
