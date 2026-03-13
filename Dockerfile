FROM node:20-alpine AS builder
RUN apk upgrade --no-cache && apk add --no-cache tini
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN NODE_OPTIONS=--max-old-space-size=4096 npx tsc
RUN npm prune --production

FROM node:20-alpine
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=builder /sbin/tini /sbin/tini
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

ENV RELAYER_NETWORK=mainnet
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
