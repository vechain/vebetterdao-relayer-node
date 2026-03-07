FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc
ENV RELAYER_NETWORK=testnet-staging
CMD ["node", "dist/index.js"]
