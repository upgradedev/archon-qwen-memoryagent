# Reproducible multi-stage production image. TypeScript and tests exist only in
# the build stage; the runtime executes compiled JavaScript as an unprivileged
# user and never invokes npx or downloads packages at startup.
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY bench ./bench
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && test "$(find node_modules -type f -name '*.node' | wc -l)" -eq 0

# Keep build, CI, package metadata, and runtime on the same reviewed LTS/ABI.
# Alpine removes the Debian package surface; the next step removes package
# managers that the compiled production service never invokes.
FROM node:24.18.0-alpine3.24@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime

# The long-lived service executes compiled JavaScript only. Remove package
# managers and their transitive graph (including npm's bundled HTTP client)
# from the production attack surface before application files are copied.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx

ENV NODE_ENV=production \
    PORT=9000
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/scripts ./dist/scripts
COPY --from=build /app/dist/bench ./dist/bench
# Non-TypeScript runtime assets referenced relative to the compiled modules.
COPY src/ui.html ./dist/src/ui.html
COPY src/db/schema.sql ./dist/src/db/schema.sql
COPY package.json ./dist/package.json

# The readiness gate imports the semantic benchmark at runtime. Fail the image
# build if that transitive artifact is ever omitted from the production stage.
RUN test -f /app/dist/bench/semantic-consistency-run.js

RUN chown -R node:node /app
USER node

EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

# Schema migration is an explicit privileged one-shot job. The long-lived
# container never receives migration credentials and cannot execute DDL.
CMD ["node", "dist/src/server.js"]
