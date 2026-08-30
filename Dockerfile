# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY . .

RUN mkdir -p "$DATA_DIR" && chown -R node:node /app

USER node

EXPOSE 3000
CMD ["node", "src/server.js"]