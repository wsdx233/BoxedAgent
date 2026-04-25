FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/var/lib/boxedagent WEB_DIST_DIR=/app/web/dist
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/server/package.json /app/server/package.json
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/web/dist /app/web/dist
COPY --from=deps /app/node_modules /app/node_modules
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
