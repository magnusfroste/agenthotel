#!/bin/sh
set -e

# Seed on FIRST BOOT, not at image build.
#
# This used to run as `python setup.py` in the Dockerfile. At build time none of
# the agent's config exists, so setup.py took its non-interactive fallback and
# baked an admin account with a random password into the image layer — printed
# once to the build log and then unrecoverable. Every container from that image
# then found an existing auth.json, skipped seeding, and ignored
# ODYSSEUS_ADMIN_PASSWORD forever, while /api/auth/setup answered "Already
# configured". The agent was unloggable-into by construction.
#
# Running it here means ODYSSEUS_ADMIN_USER / ODYSSEUS_ADMIN_PASSWORD from the
# agent config are present, and auth.json lands in ODYSSEUS_DATA_DIR (a mounted
# volume) instead of the container's throwaway layer.
#
# Every step in setup.py is idempotent — makedirs(exist_ok), create_all(),
# and skips when .env / auth.json already exist — so this is safe on restart.
DATA_DIR="${ODYSSEUS_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if ! python setup.py; then
  echo "[entrypoint] WARNING: setup.py failed — the admin account may not exist."
  echo "[entrypoint] Set ODYSSEUS_ADMIN_USER and ODYSSEUS_ADMIN_PASSWORD on the agent and redeploy."
fi

# With no ODYSSEUS_ADMIN_PASSWORD set, setup.py generates one and prints it
# above — readable from the panel's Logs tab, unlike the old build-time run.
exec python -m uvicorn app:app --host 0.0.0.0 --port 7000
