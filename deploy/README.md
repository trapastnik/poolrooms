# Публикация POOLROOMS на VPS

Игра и редактор — это два самодостаточных `.html` файла (three.js и весь код вшиты
внутрь). Внешние ресурсы не грузятся, база данных не нужна — это чистая статика.
Задача сводится к «положить файлы на сервер и раздать их веб-сервером».

Что попадает на сервер (в `/var/www/poolrooms`):

| Файл | URL | Что это |
|---|---|---|
| `index.html` | `/` | редирект на игру |
| `game.html` | `/game.html` | игра |
| `editor.html` | `/editor.html` | редактор уровней |

---

## Шаг 1. Залить файлы

С этой машины (Windows, PowerShell):

```powershell
./deploy/deploy.ps1 -Server root@ВАШ_IP
```

Linux / macOS / Git Bash:

```bash
./deploy/deploy.sh root@ВАШ_IP
```

Скрипт сам пересоберёт прод-бандл и зальёт три файла в `/var/www/poolrooms`.
Порт и путь можно переопределить: `-Port 2222 -Path /srv/poolrooms` (или как позиционные
аргументы в bash-версии).

> Нужен вход по SSH-ключу. Если ключа нет — команда попросит пароль сервера,
> введёте его сами. Пароли я (ассистент) не ввожу по правилам безопасности.

Залить вручную, без скрипта:

```bash
ssh root@ВАШ_IP "mkdir -p /var/www/poolrooms"
scp game.html   root@ВАШ_IP:/var/www/poolrooms/game.html
scp editor.html root@ВАШ_IP:/var/www/poolrooms/editor.html
scp deploy/index.html root@ВАШ_IP:/var/www/poolrooms/index.html
```

---

## Шаг 2. Раздать веб-сервером

### Вариант A — Caddy (рекомендую: HTTPS сам, конфиг в 4 строки)

```bash
# на сервере
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Скопируйте `deploy/Caddyfile` на сервер, впишите свой домен, перезапустите:

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Домен уже должен указывать A-записью на IP сервера — тогда Caddy сам получит
и продлит TLS-сертификат Let's Encrypt. Нет домена — поставьте `:80` вместо домена
в `Caddyfile`, откроется по `http://ВАШ_IP/`.

### Вариант B — nginx

```bash
sudo cp deploy/nginx-poolrooms.conf /etc/nginx/sites-available/poolrooms
sudo ln -s /etc/nginx/sites-available/poolrooms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# HTTPS:
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ВАШ_ДОМЕН
```

---

## Шаг 3. Firewall

```bash
sudo ufw allow 80
sudo ufw allow 443
```

---

## Обновление после правок

Просто снова запустите `deploy.ps1` / `deploy.sh` — он пересоберёт и перезальёт
файлы. Веб-сервер трогать больше не нужно. Короткий кэш (`max-age=300`) в конфигах
следит, чтобы новая версия долетала до игроков за пять минут.

## Требования к VPS

Минимальные: 1 vCPU / 512 МБ RAM / любой современный Linux. Игра считается целиком
в браузере игрока — сервер только отдаёт статику, нагрузка на него почти нулевая.
Порядка ~1.3 МБ трафика на первого посетителя (два html), дальше из кэша.
