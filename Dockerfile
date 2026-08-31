# Stage 1: Install dependencies (production only)
FROM node:22-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild bcrypt --build-from-source \
    && npm cache clean --force \
    && find /app/node_modules -type f \( -name '*.md' -o -name '*.ts' -o -name '*.map' \) -delete \
    && find /app/node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} + 2>/dev/null || true

# Stage 2: Runtime image
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

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
