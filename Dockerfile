FROM node:22-alpine
RUN apk add --no-cache build-base python3
ENV NODE_ENV=production
WORKDIR /app
COPY ["package.json", "package-lock.json", "./"]
RUN npm install --production
COPY . .
RUN mkdir -p storage
CMD ["node", "index.js"]
