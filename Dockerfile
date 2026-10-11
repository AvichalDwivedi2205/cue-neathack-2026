FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://cue.latchgrid.in/auth/callback
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/design ./design
COPY --from=build --chown=node:node /app/lib/browser ./lib/browser
COPY --from=build --chown=node:node /app/deploy ./deploy
USER node
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 CUE_FFMPEG_PATH=/usr/bin/ffmpeg
EXPOSE 8080
CMD ["node", "deploy/start.mjs"]
