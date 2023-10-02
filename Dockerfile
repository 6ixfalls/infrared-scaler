FROM oven/bun:alpine

COPY package.json ./
COPY bun.lockb ./

USER node

RUN bun install

COPY . .