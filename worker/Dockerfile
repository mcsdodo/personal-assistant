# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine

# Build context: compose.stacks/infra/personal-assistant/claude-code
# (so /channels lives at the root of the build context, matching workflow-mcp).
WORKDIR /app

# qpdf is required by download-helper.tryDecrypt / isPdfEncrypted for the
# encrypted-PDF guidance pause flow (task 57). Without it, both helpers
# exit 127 and the catch block silently treats every PDF as plaintext —
# the worker would skip the decrypt attempt AND the guidance pause, and
# Claude would receive an unreadable encrypted PDF for classification.
RUN apk add --no-cache qpdf libjpeg-turbo poppler-utils

COPY channels/package.json channels/bunfig.toml channels/tsconfig.json ./channels/
RUN cd channels && bun install --no-summary

COPY channels ./channels

RUN mkdir -p /data/email-watcher /workspace/downloads

EXPOSE 8003

ENTRYPOINT ["bun", "run", "/app/channels/worker.ts"]
