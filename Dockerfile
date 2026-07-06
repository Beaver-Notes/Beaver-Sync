# Stage 1: Install dependencies
FROM node:24-alpine AS deps

RUN apk add --no-cache \
    python3 \
    make \
    g++

WORKDIR /app

COPY package*.json ./

RUN yarn install --frozen-lockfile --production && yarn cache clean

# Stage 2: Runtime image
FROM node:24-alpine AS runtime

RUN apk add --no-cache wget

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

RUN addgroup -S beaver && adduser -S beaver -G beaver
RUN mkdir -p /app/data /app/keys && chown -R beaver:beaver /app
USER beaver

EXPOSE 3000

STOPSIGNAL SIGTERM

CMD ["node", "src/server.js"]
