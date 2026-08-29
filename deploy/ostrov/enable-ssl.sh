#!/usr/bin/env bash
# Выпустить сертификат и подключить домен к POOLROOMS.
# Запускать НА СЕРВЕРЕ. Требует, чтобы A-запись домена уже указывала сюда.
set -euo pipefail

DOMAIN="${1:-poolrooms.ostrov-vezeniya.ru}"
EMAIL="${2:-dimitri@dvn.spb.ru}"
CONF=/srv/infrastructure/proxy.conf
WEBROOT=/srv/infrastructure/certbot-webroot

ip_of_server=$(curl -4 -s ifconfig.me || echo '')
ip_of_domain=$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || echo '')
if [ -z "$ip_of_domain" ]; then
  echo "ОШИБКА: $DOMAIN не резолвится. Сначала A-запись → $ip_of_server" >&2
  exit 1
fi
if [ -n "$ip_of_server" ] && [ "$ip_of_domain" != "$ip_of_server" ]; then
  echo "ОШИБКА: $DOMAIN указывает на $ip_of_domain, а сервер $ip_of_server" >&2
  exit 1
fi
echo "DNS в порядке: $DOMAIN → $ip_of_domain"

if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" \
    --non-interactive --agree-tos -m "$EMAIL"
else
  echo "сертификат уже есть, пропускаю выпуск"
fi

if grep -q "server_name $DOMAIN;" "$CONF"; then
  echo "блок уже в proxy.conf, пропускаю"
else
  cp "$CONF" "$CONF.bak.$(date +%Y%m%d%H%M%S)"     # откат под рукой
  cat /var/www/poolrooms/proxy-poolrooms.conf >> "$CONF"
  echo "блок добавлен, бэкап рядом"
fi

docker exec infrastructure-proxy-1 nginx -t
docker exec infrastructure-proxy-1 nginx -s reload
echo "готово: https://$DOMAIN/"
