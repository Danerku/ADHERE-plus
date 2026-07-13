FROM php:8.2-apache
RUN apt-get update && apt-get install -y --no-install-recommends libonig-dev && rm -rf /var/lib/apt/lists/* \
    && docker-php-ext-install pdo pdo_mysql mbstring && a2enmod rewrite

# ---- OPcache -----------------------------------------------------------------------------
# The box is 1 vCPU. Without OPcache, PHP re-parsed ~100 KB of index.php on EVERY request —
# pure waste on the smallest machine we have. validate_timestamps=0 means a deploy needs the
# container to restart to pick up new PHP, which is exactly what deploy-adhere.sh does.
RUN docker-php-ext-install opcache
RUN { \
      echo 'opcache.enable=1'; \
      echo 'opcache.enable_cli=0'; \
      echo 'opcache.memory_consumption=64'; \
      echo 'opcache.interned_strings_buffer=8'; \
      echo 'opcache.max_accelerated_files=4000'; \
      echo 'opcache.validate_timestamps=0'; \
    } > /usr/local/etc/php/conf.d/opcache.ini

# ---- Apache process model ----------------------------------------------------------------
# php:8.2-apache runs mpm_prefork with MaxRequestWorkers 150. Each mod_php worker is ~30-60 MB,
# so 150 of them is far more than the 2 GB droplet has — and the clients are slow 2G tablets that
# hold a connection open for a long time, which is precisely how you reach the worker ceiling.
# Left alone this OOM-kills the box under a burst. Cap the workers to what the RAM can actually
# hold, and recycle them to bound any leak.
RUN { \
      echo '<IfModule mpm_prefork_module>'; \
      echo '  StartServers 2'; \
      echo '  MinSpareServers 2'; \
      echo '  MaxSpareServers 6'; \
      echo '  MaxRequestWorkers 16'; \
      echo '  MaxConnectionsPerChild 1000'; \
      echo '</IfModule>'; \
      echo 'Timeout 30'; \
      echo 'KeepAliveTimeout 3'; \
      echo 'ServerTokens Prod'; \
      echo 'ServerSignature Off'; \
    } > /etc/apache2/conf-available/adhere-tuning.conf \
    && a2enconf adhere-tuning

RUN mkdir -p /var/adhere-sessions && chown www-data:www-data /var/adhere-sessions
COPY public/ /var/www/html/
RUN sed -ri 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf || true
EXPOSE 80
