FROM node:22-alpine AS builder
RUN apk add --no-cache build-base python3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --production

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
RUN mkdir -p storage
CMD ["node", "index.js"]
