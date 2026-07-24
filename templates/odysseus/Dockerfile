FROM python:3.11-slim

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ripgrep sudo \
    chromium-browser \
    chromium-codecs-ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --depth 1 https://github.com/magnusfroste/odysseus.git /app \
    && pip install --no-cache-dir -r requirements.txt \
    && python setup.py || true

RUN mkdir -p /data /config
VOLUME ["/data", "/config"]

EXPOSE 7000

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
