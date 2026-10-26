# The image the app shipped on 2026-10-20: PHP 8.4.26, before php2shell's fix.
FROM composer:2.8.12 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts

FROM php:8.4.26-fpm-alpine AS app
WORKDIR /var/www/html
COPY --from=vendor /app/vendor ./vendor
COPY . .
