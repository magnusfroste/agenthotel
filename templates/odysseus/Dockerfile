FROM python:3.11-slim

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ripgrep sudo \
    chromium \
    chromium-common \
    chromium-driver \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deliberately NO `python setup.py` here — it must run at container start, with
# the agent's config in the environment. See entrypoint.sh for the full reason.
RUN git clone --depth 1 https://github.com/magnusfroste/odysseus.git /app \
    && pip install --no-cache-dir -r requirements.txt

# constants.py: ODYSSEUS_DATA_DIR is the single source of truth for every
# persisted file (auth.json, app.db, sessions, uploads, memory). It defaulted to
# /app/data — inside the image layer, not a volume — so all state, including the
# admin account, was silently lost on every redeploy. Point it at the volume.
ENV ODYSSEUS_DATA_DIR=/data

RUN mkdir -p /data /config
VOLUME ["/data", "/config"]

EXPOSE 7000

# The panel builds through the Engine API (classic builder, no BuildKit), so no
# heredocs and no COPY --chmod here.
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
