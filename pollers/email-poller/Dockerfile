# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine

# Build context: compose.stacks/infra/personal-assistant/ (stack root, so the
# dependency-free shared/ modules are reachable — task 102). In-image layout
# is unchanged: lib + poller src under /app, shared sources at /shared
# (matches the ../../shared relative imports from /app/lib/*.ts).
WORKDIR /app

# Install shared deps once at /app, both pollers reuse them.
COPY pollers/package.json pollers/bunfig.toml pollers/tsconfig.json ./
RUN bun install --no-summary --frozen-lockfile || bun install --no-summary

# Single-source-of-truth modules (dependency-free — no node_modules needed).
COPY shared /shared

# Copy shared lib (consumed by relative import ../../lib/...)
COPY pollers/lib ./lib

# Poller source
COPY pollers/email-poller/src ./email-poller/src
COPY pollers/email-poller/cli ./email-poller/cli

# Mount points for SQLite databases (bind-mounted at runtime)
RUN mkdir -p /data/email-watcher

# Health endpoint port
EXPOSE 9465

ENTRYPOINT ["bun", "run", "/app/email-poller/src/main.ts"]
