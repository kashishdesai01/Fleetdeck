FROM node:22.23.2-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund --no-audit
COPY . .
RUN npm run build

FROM node:22.23.2-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN mkdir -p /app/.local && chown node:node /app/.local
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --chown=node:node db ./db
USER node
EXPOSE 3080
CMD ["node", "dist/apps/api/src/main.js"]
