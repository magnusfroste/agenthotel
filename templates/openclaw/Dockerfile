FROM ghcr.io/openclaw/openclaw:latest

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    python3 python3-pip \
    git ripgrep sudo curl \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /data /config
VOLUME ["/data", "/config"]

EXPOSE 18789

CMD ["openclaw", "gateway", "--allow-unconfigured"]
