FROM node:20-slim

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl unzip jq procps \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Bun (required for channel plugins)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Create workspace and config dirs
RUN mkdir -p /workspace /root/.claude

WORKDIR /workspace

# Copy channel scripts and install deps
COPY channels/ /app/channels/
RUN cd /app/channels && bun install --no-summary

# Copy MCP and project config
COPY .mcp.json /workspace/.mcp.json
COPY CLAUDE.md /workspace/CLAUDE.md

# Claude Code remote-control listens for connections via outbound HTTPS
# No inbound ports needed
ENTRYPOINT ["claude", "remote-control", \
  "--dangerously-load-development-channels", "server:email-watcher"]
