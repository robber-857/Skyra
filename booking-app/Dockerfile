FROM node:22-alpine AS base

RUN apk add --no-cache dumb-init openssl
WORKDIR /app

FROM base AS build

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY extensions ./extensions
RUN npm ci

COPY . .

# Render exposes its stable public URL at build time. React Router compiles the
# exact action-origin allowlist during this stage.
ARG RENDER_EXTERNAL_URL
ARG RENDER_EXTERNAL_HOSTNAME
ENV RENDER_EXTERNAL_URL=$RENDER_EXTERNAL_URL
ENV RENDER_EXTERNAL_HOSTNAME=$RENDER_EXTERNAL_HOSTNAME

RUN npm run build && npm run build:worker

FROM base AS runtime

ENV NODE_ENV=production
EXPOSE 10000

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY extensions ./extensions
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/scripts/start-render.mjs ./scripts/start-render.mjs

COPY --from=build --chown=node:node /app/scripts/production-readiness.mjs ./scripts/production-readiness.mjs

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start:render"]
