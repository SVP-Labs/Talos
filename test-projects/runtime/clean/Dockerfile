# syntax=docker/dockerfile:1
ARG PHP_VERSION=8.5.12

FROM node:24.22.1-slim AS assets
WORKDIR /build
COPY package.json pnpm-lock.yaml ./
RUN <<EOS
corepack enable
pnpm install --frozen-lockfile
EOS

FROM php:${PHP_VERSION}-fpm-alpine AS app
COPY --from=assets /build/dist /var/www/html/public
