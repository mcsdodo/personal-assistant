FROM node:20-slim

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
  git curl unzip jq procps ca-certificates tmux \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Bun (required for channel plugins) as node user
USER node
ENV BUN_INSTALL="/home/node/.bun"
ENV PATH="$BUN_INSTALL/bin:$PATH"
RUN curl -fsSL https://bun.sh/install | bash \
  && bun --version

# Install Claude Code CLI (needs root for global install)
USER root
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Create workspace and config dirs owned by node
RUN mkdir -p /workspace /home/node/.claude \
  && echo '{"skipDangerousModePermissionPrompt": true}' > /home/node/.claude/settings.json \
  && chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

# Copy channel scripts and install deps as node
USER node
COPY --chown=node:node channels/ /app/channels/
RUN cd /app/channels && bun install --no-summary

# Clone official Telegram channel plugin and install its deps
RUN git clone --depth 1 https://github.com/anthropics/claude-plugins-official.git /tmp/claude-plugins \
  && cp -r /tmp/claude-plugins/external_plugins/telegram /app/channels/telegram \
  && cd /app/channels/telegram && bun install --no-summary \
  && rm -rf /tmp/claude-plugins

# Copy MCP and project config
USER root
COPY --chown=node:node .mcp.json /workspace/.mcp.json
COPY --chown=node:node CLAUDE.md /workspace/CLAUDE.md
COPY --chown=node:node agents/ /workspace/.claude/agents/
COPY --chown=node:node .claude.json /home/node/.claude.json
COPY --chown=node:node entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER node
ENV HOME=/home/node

ENTRYPOINT ["/entrypoint.sh"]
