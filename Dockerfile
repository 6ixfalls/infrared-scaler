FROM oven/bun:alpine

COPY package.json ./
COPY bun.lockb ./

RUN bun install

COPY . .
