FROM node:24-bookworm-slim AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY test ./test
COPY *.sh ./
COPY Dockerfile .dockerignore ./
RUN node --test test/*.test.mjs

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210 DATA_DIR=/app/data
WORKDIR /app
RUN mkdir -p /app/data && chown node:node /app/data
COPY --from=test --chown=node:node /app/package.json ./
COPY --from=test --chown=node:node /app/node_modules ./node_modules
COPY --from=test --chown=node:node /app/src ./src
COPY --from=test --chown=node:node /app/public ./public
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3210/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.mjs"]
