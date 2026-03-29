FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY frontend/ .
RUN npm run build

FROM node:22-alpine AS builder
RUN apk add --no-cache build-base python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --production

FROM node:22-alpine
RUN apk add --no-cache build-base python3
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
COPY --from=frontend /app/frontend/dist ./public
RUN mkdir -p storage
CMD ["node", "index.js"]
