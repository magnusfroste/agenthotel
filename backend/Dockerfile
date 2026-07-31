FROM node:22-alpine
# util-linux provides nsenter, used to run console commands on the VPS host
RUN apk add --no-cache git docker-cli docker-compose python3 make g++ util-linux
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ARG GIT_COMMIT=unknown
ARG GIT_VERSION=unknown
ENV GIT_COMMIT=${GIT_COMMIT}
ENV GIT_VERSION=${GIT_VERSION}
EXPOSE 8080
CMD ["node", "server.js"]
