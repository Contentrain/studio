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

# `.git` is not in the build context, so the build cannot ask git which commit
# it is. The release workflow passes SOURCE_COMMIT; Railway exposes its own
# variable to the build. Either lands in runtimeConfig.public.build.commit,
# which /about and /api/health report. Leave both unset and the build shows
# its version alone.
ARG SOURCE_COMMIT=""
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV SOURCE_COMMIT=$SOURCE_COMMIT
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA

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

# Database migration runner + SQL lineage. The managed pair does NOT migrate
# at app start; the Railway pre-deploy command (`node scripts/migrate-postgres.mjs`)
# runs this before the new image serves, so the schema is always applied ahead
# of the release. The app bundles its own pg inside .output; this standalone
# runner lives outside that tree, so it gets a self-contained pg (its only
# non-builtin import, matched to the app's resolved 8.22.0).
COPY --from=build /app/scripts/migrate-postgres.mjs /app/scripts/verify-managed-schema.mjs ./scripts/
COPY --from=build /app/postgres/migrations ./postgres/migrations
COPY --from=build /app/supabase/migrations ./supabase/migrations
RUN printf '{"name":"studio-migrations","private":true,"type":"module"}\n' > package.json \
  && npm install --no-fund --no-audit pg@8.22.0 \
  && npm cache clean --force

# Git needs a writable home for config
ENV HOME=/home/studio
ENV NODE_ENV=production
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0

RUN chown -R studio:studio /app

USER studio

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
