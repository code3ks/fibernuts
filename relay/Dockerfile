FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 --create-home relay
COPY --from=build --chown=relay:relay /app/package.json ./package.json
COPY --from=build --chown=relay:relay /app/node_modules ./node_modules
COPY --from=build --chown=relay:relay /app/dist ./dist
RUN mkdir -p /app/data && chown relay:relay /app/data
USER relay
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
