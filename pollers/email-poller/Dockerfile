# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bunfig.toml tsconfig.json ./
RUN bun install --no-summary --frozen-lockfile || bun install --no-summary

COPY lib ./lib
COPY email-poller/src ./email-poller/src
COPY email-poller/cli ./email-poller/cli

RUN mkdir -p /data/email-watcher

EXPOSE 9465

ENTRYPOINT ["bun", "run", "/app/email-poller/src/main.ts"]
