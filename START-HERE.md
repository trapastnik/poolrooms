# POOLROOMS — с чего начать

Внутри — игра про poolrooms / лиминальные пространства (three.js: вода, каустики,
объёмный свет) и редактор уровней. Всё уже собрано.

## Просто посмотреть
Открой `game.html` двойным кликом. Редактор — `editor.html`. Интернет не нужен,
всё вшито в файлы.

Управление в игре: мышь — обзор (или зажать ЛКМ и вести, или стрелки),
WASD — движение, Shift — бег, Space — всплыть, F3 — панель параметров рендера.

## Задеплоить на VPS
Разверни на сервере только два файла — `game.html` и `editor.html` — плюс редирект
`deploy/index.html`. Готовые конфиги веб-сервера и скрипты заливки лежат в папке
**`deploy/`**, пошаговая инструкция — в `deploy/README.md`.

Быстрый путь (Caddy, авто-HTTPS):
```
scp game.html editor.html deploy/index.html  user@СЕРВЕР:/var/www/poolrooms/
# на сервере: положить deploy/Caddyfile в /etc/caddy/Caddyfile и reload caddy
```

## Пересобрать после правок исходников (в `src/`)
```
npm install      # поставит three и esbuild
npm run build    # соберёт game.html и editor.html заново
```

## Что где
```
game.html          собранная игра (открывается сама по себе)
editor.html        собранный редактор уровней
src/               исходники (core — движок, game — игра, editor — редактор)
build.mjs          сборщик (esbuild, инлайнит всё в один html)
deploy/            конфиги VPS + скрипты заливки + README
```
