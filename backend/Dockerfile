FROM node:20-alpine
RUN apk add --no-cache git docker-cli python3 make g++
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
