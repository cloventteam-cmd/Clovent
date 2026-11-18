FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY backend/package.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm ci && npm ci --prefix frontend
COPY backend/tsconfig.json ./backend/
COPY backend/src ./backend/src
COPY frontend/ ./frontend/
RUN npm run build
RUN npm run build --prefix frontend

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY backend/package.json ./backend/
RUN npm ci --omit=dev
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/src/db/migrations ./backend/dist/db/migrations
COPY --from=builder /app/backend/public ./backend/public
RUN mkdir -p /app/uploads
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
