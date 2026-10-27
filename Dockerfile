# Mail service application image: the API, worker, tracker and admin commands share it.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
COPY scripts scripts
RUN npx tsc -p tsconfig.json

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist dist
COPY migrations migrations
COPY templates templates
RUN mkdir -p /secrets/dkim && chown node:node /secrets/dkim
USER node
ENV DKIM_KEYS_DIR=/secrets/dkim
CMD ["node", "dist/src/api.js"]
