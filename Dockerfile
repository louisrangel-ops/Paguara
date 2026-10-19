# Imagen única para la API y para los procesos auxiliares (migraciones, dev-jobs, seed).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src src
COPY scripts scripts
COPY test test
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
COPY db db
COPY public public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Migra y arranca: el bloqueo consultivo de migrate.ts evita choques si arrancan dos réplicas a la vez.
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/src/main.js"]
