FROM php:8.2-apache
RUN apt-get update && apt-get install -y --no-install-recommends libonig-dev && rm -rf /var/lib/apt/lists/* \
    && docker-php-ext-install pdo pdo_mysql mbstring && a2enmod rewrite
RUN mkdir -p /var/adhere-sessions && chown www-data:www-data /var/adhere-sessions
COPY public/ /var/www/html/
RUN sed -ri 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf || true
EXPOSE 80
