# ── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM node:22-slim AS deps

RUN corepack enable && corepack prepare pnpm@10.26.2 --activate

WORKDIR /app

COPY . .
RUN pnpm install --frozen-lockfile --prod=false

# ── Stage 2: Build ────────────────────────────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@10.26.2 --activate

WORKDIR /app

COPY --from=deps /app ./

RUN pnpm build

# ── Stage 3: Production runtime ───────────────────────────────────────────────
FROM node:22-slim AS runtime

# git is required for content operations (clone, branch, commit, push)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Non-root user for security
RUN groupadd -r studio && useradd -r -g studio -m studio

WORKDIR /app

# Copy built output
COPY --from=build /app/.output ./.output

# Contentrain content (needed for UI strings via @contentrain/query)
COPY --from=build /app/.contentrain ./.contentrain

# Git needs a writable home for config
ENV HOME=/home/studio
ENV NODE_ENV=production
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0

RUN chown -R studio:studio /app

USER studio

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
