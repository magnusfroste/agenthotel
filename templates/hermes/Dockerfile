FROM nousresearch/hermes-agent:latest

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    python3 python3-pip python3-venv \
    git ripgrep sudo curl \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

RUN mkdir -p /data /config
VOLUME ["/data", "/config"]

EXPOSE 9119

CMD ["gateway", "run"]
