FROM node:20-alpine AS builder
RUN apk add --no-cache tini
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN NODE_OPTIONS=--max-old-space-size=4096 npx tsc
RUN npm prune --production

FROM node:20-alpine3.23
RUN apk update && apk upgrade -U && rm -rf /var/cache/apk/*
# Drop npm from the runtime image. The container runs `node dist/index.js` and never
# shells out to npm, but npm bundles its own dependency tree — including tar 6.2.1, which
# trips the CRITICAL gate in the Trivy step (CVE-2026-59873). That tar is the base image's,
# not ours: it appears nowhere in package-lock.json or yarn.lock. Removing npm clears the
# scan and drops runtime attack surface we were never using.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=builder /sbin/tini /sbin/tini
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

ENV RELAYER_NETWORK=mainnet
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
