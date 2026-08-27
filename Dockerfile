FROM node:22-slim

# Claude Code CLI — the Agent SDK drives it; auth via CLAUDE_CODE_OAUTH_TOKEN.
# Pinned so image builds are reproducible; bump deliberately.
RUN npm install -g @anthropic-ai/claude-code@2.1.247

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

# Webhook mode. Set STATE_FILE=/data/state.json if a persistent volume is
# mounted at /data; otherwise state is ephemeral (safe: a fresh state only
# re-indexes silently, it never answers old comments).
CMD ["npx", "tsx", "src/webhook.ts"]
