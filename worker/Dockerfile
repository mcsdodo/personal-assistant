# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine

# Build context: compose.stacks/infra/personal-assistant/claude-code
# (so /channels lives at the root of the build context, matching workflow-mcp).
WORKDIR /app

COPY channels/package.json channels/bunfig.toml channels/tsconfig.json ./channels/
RUN cd channels && bun install --no-summary

COPY channels ./channels

RUN mkdir -p /data/email-watcher /workspace/downloads

EXPOSE 8003

ENTRYPOINT ["bun", "run", "/app/channels/worker.ts"]
