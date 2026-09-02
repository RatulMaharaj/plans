# The workspace server, as looped builds its services: Alpine Node, a
# non-root user, and the pinned Infisical CLI so secrets are pulled at start
# rather than baked in. Built from the repository root:
#
#   docker build -f server/Dockerfile -t plans-workspaces .
#
# Runs with no environment at all — an in-process Postgres and no sign-in —
# which is enough to see it answer /health. Real deployments set
# DATABASE_URL and GITHUB_CLIENT_ID, through Infisical (see the entrypoint).
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY server/package.json server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile --prefer-offline --filter plans-workspaces --prod

FROM node:24-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Infisical CLI — a static Go binary from GitHub releases, so it runs on musl.
# Bump to update.
ARG INFISICAL_VERSION=0.43.100
RUN apk add --no-cache curl tar \
  && curl -fsSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/cli_${INFISICAL_VERSION}_linux_amd64.tar.gz" -o /tmp/infisical.tar.gz \
  && tar -xzf /tmp/infisical.tar.gz -C /usr/local/bin infisical \
  && rm /tmp/infisical.tar.gz \
  && infisical --version

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 -G nodejs plans
COPY --chown=plans:nodejs --from=deps /app/node_modules ./node_modules
COPY --chown=plans:nodejs --from=deps /app/server/node_modules ./server/node_modules
COPY --chown=plans:nodejs server/package.json ./server/
COPY --chown=plans:nodejs server/src ./server/src
COPY --chown=plans:nodejs server/drizzle ./server/drizzle
COPY --chown=plans:nodejs server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER plans

ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health || exit 1

WORKDIR /app/server
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
