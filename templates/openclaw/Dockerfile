ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo build-essential \
    python3 python3-pip python3-venv python3-dev \
    git ripgrep curl wget ca-certificates \
    jq unzip zip openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages uv \
    || (curl -LsSf https://astral.sh/uv/install.sh | sh)

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/home/node/.local/bin:$PATH
RUN mkdir -p /home/node/.local/bin /home/node/.cache /data /config \
    && chown -R node:node /home/node/.local /home/node/.cache

RUN echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

VOLUME ["/home/node/.openclaw", "/home/node/.cache", "/home/node/.local", "/data", "/config"]

EXPOSE 18789

CMD ["openclaw", "gateway", "--allow-unconfigured"]
