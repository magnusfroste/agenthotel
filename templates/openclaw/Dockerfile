ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    sudo build-essential \
    python3 python3-pip python3-venv python3-dev \
    git ripgrep curl wget ca-certificates tmux \
    jq unzip zip openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir --break-system-packages uv \
    || (curl -LsSf https://astral.sh/uv/install.sh | sh)

# Always install latest OpenClaw on image build
RUN rm -f /usr/local/bin/openclaw && npm install -g openclaw@latest

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

ENV PATH=/home/node/.local/bin:$PATH
RUN mkdir -p /home/node/.local/bin /home/node/.cache /home/node/.openclaw /data /config \
    && chown -R node:node /home/node/.local /home/node/.cache /home/node/.openclaw

RUN echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

VOLUME ["/home/node/.openclaw", "/home/node/.cache", "/home/node/.local", "/data", "/config"]

EXPOSE 18789

# The panel builds template images through the Engine API (dockerode), which
# uses the classic builder — no BuildKit. Heredocs and COPY --chmod are
# BuildKit-only, so the entrypoint lives in its own file and is chmod'd in a
# RUN step. Keep it that way or the image silently stops building.
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
