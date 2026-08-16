FROM node:22-alpine
# util-linux provides nsenter, used to run console commands on the VPS host
RUN apk add --no-cache git docker-cli docker-compose python3 make g++ util-linux
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# The running version is baked in here, last so it only invalidates this layer.
# Pass it at build time: docker compose build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD)
ARG GIT_COMMIT=unknown
ARG GIT_VERSION=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_VERSION=${GIT_VERSION}
EXPOSE 8080
CMD ["node", "server.js"]
