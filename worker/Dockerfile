# syntax=docker/dockerfile:1.7
FROM oven/bun:1-alpine

# Build context: compose.stacks/infra/personal-assistant/ (stack root — task
# 102, so shared/ is reachable). Channels still live at /app/channels; the
# dependency-free shared/ modules land at /shared, matching the ../../shared
# relative imports from /app/channels/*.ts.
WORKDIR /app

# qpdf is required by download-helper.tryDecrypt / isPdfEncrypted for the
# encrypted-PDF guidance pause flow (task 57). Without it, both helpers
# exit 127 and the catch block silently treats every PDF as plaintext —
# the worker would skip the decrypt attempt AND the guidance pause, and
# Claude would receive an unreadable encrypted PDF for classification.
RUN apk add --no-cache qpdf libjpeg-turbo poppler-utils

COPY claude-code/channels/package.json claude-code/channels/bunfig.toml claude-code/channels/tsconfig.json claude-code/channels/bun.lock ./channels/
RUN cd channels && bun install --no-summary

COPY shared /shared
COPY claude-code/channels ./channels

RUN mkdir -p /data/email-watcher /workspace/downloads

EXPOSE 8003

ENTRYPOINT ["bun", "run", "/app/channels/worker.ts"]
