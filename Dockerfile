# Runs one room server per container — the shape a hosted control plane
# provisions against. This is the only interface a separate hosting/billing
# system should ever depend on: the published image (or the npm package),
# never this repository's source tree. See CLAUDE.md, "Hosting boundary".
#
# Build:  docker build -t multiplayer-cli .
# Run:    docker run -p 7777:7777 multiplayer-cli share --host 0.0.0.0 --backend echo --policy pair
#
# `--host 0.0.0.0` is required — the default is loopback-only, which is
# correct for a laptop and wrong inside a container.

FROM node:20.11-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20.11-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# A room's token is a key, not a password (see CLAUDE.md, "Things worth
# knowing before you touch them") — nothing here needs a secret baked in.
EXPOSE 7777
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["share", "--host", "0.0.0.0"]
