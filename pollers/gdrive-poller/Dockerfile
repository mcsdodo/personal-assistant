# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine

# Build context: compose.stacks/infra/personal-assistant/ (stack root — task 102).
WORKDIR /app

# Install shared deps once at /app, both pollers reuse them.
COPY pollers/package.json pollers/bunfig.toml pollers/tsconfig.json ./
RUN bun install --no-summary --frozen-lockfile || bun install --no-summary

# Single-source-of-truth modules (dependency-free — no node_modules needed).
COPY shared /shared

# Copy shared lib (consumed by relative import ../../lib/...)
COPY pollers/lib ./lib

# Poller source
COPY pollers/gdrive-poller/src ./gdrive-poller/src

# Mount points for SQLite databases (bind-mounted at runtime)
RUN mkdir -p /data/gdrive-watcher /data/email-watcher

# Health endpoint port
EXPOSE 9466

ENTRYPOINT ["bun", "run", "/app/gdrive-poller/src/main.ts"]
