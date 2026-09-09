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

# Pinned on purpose. Two hosts building weeks apart used to get different
# software: an image built in August ran 2026.7.1-2 happily while a fresh
# build of the same Dockerfile pulled a release that could not start at all,
# and the failure surfaced on the new machine rather than here. A build is
# also expensive now — the image is ~9 GB and needs roughly 10 GB of free
# space while the old and new layers coexist — so it is not something an
# operator should trigger unknowingly by creating their first agent.
#
# To upgrade: raise OPENCLAW_VERSION, rebuild, and check the agent reaches
# "[gateway] ready" without restarting.
ARG OPENCLAW_VERSION=2026.9.3
RUN rm -f /usr/local/bin/openclaw && npm install -g openclaw@${OPENCLAW_VERSION}

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
# OpenClaw installs globally as root, but the container runs as node. Newer
# releases finish their package lifecycle on first run and write a lock
# directory inside their own module folder to do it — which a non-root process
# cannot create. The agent then failed to start and restart-looped forever with
# "package lifecycle is incomplete ... EACCES", which reads as a packaging
# problem rather than a permission one.
#
# Not recursive. Creating a directory needs write permission on its parent,
# not on the parent's contents — and a recursive chown rewrites every file's
# metadata, which Docker records as a full copy of the tree: 553 MB for what
# is a permission bit on one directory. Verified by resetting the tree to root,
# chowning only the folder, and watching the gateway reach ready.
#
# Kept last on purpose: it is a thin layer, so fixing it never rebuilds the
# playwright install above.
RUN chown node:node /usr/local/lib/node_modules/openclaw

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
