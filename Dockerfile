# Reproducible multi-stage production image. TypeScript and tests exist only in
# the build stage; the runtime executes compiled JavaScript as an unprivileged
# user and never invokes npx or downloads packages at startup.
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY bench ./bench
RUN npm run build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

ENV NODE_ENV=production \
    PORT=9000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

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
