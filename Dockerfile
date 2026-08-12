# Stage 1: Install dependencies
FROM node:22-alpine AS deps

RUN apk add --no-cache \
    python3 \
    make \
    g++

WORKDIR /app

COPY package*.json ./

RUN yarn install --frozen-lockfile --production && yarn cache clean

# Stage 2: Runtime image
FROM node:22-alpine AS runtime

RUN apk add --no-cache wget openssl

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

RUN addgroup -S beaver && adduser -S beaver -G beaver \
    && chmod +x /app/docker-entrypoint.sh \
    && mkdir -p /app/keys \
    && chown -R beaver:beaver /app

USER beaver

EXPOSE 3000

STOPSIGNAL SIGTERM

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
