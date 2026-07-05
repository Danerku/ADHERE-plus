FROM php:8.2-apache
RUN docker-php-ext-install pdo pdo_mysql && a2enmod rewrite
RUN mkdir -p /var/adhere-sessions && chown www-data:www-data /var/adhere-sessions
COPY public/ /var/www/html/
RUN sed -ri 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf || true
EXPOSE 80
