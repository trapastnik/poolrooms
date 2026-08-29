#!/usr/bin/env bash
# Деплой POOLROOMS на VPS по SSH (Linux / macOS / Git Bash).
# Требуется вход по SSH-ключу (иначе scp спросит пароль — введёте сами).
#
# Использование:
#   ./deploy/deploy.sh user@host [/var/www/poolrooms] [port]
set -euo pipefail

SERVER="${1:?Укажите user@host, напр. root@203.0.113.10}"
DEST="${2:-/var/www/poolrooms}"
PORT="${3:-22}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== Сборка прод-бандла =="
( cd "$ROOT" && node build.mjs )

echo "== Каталог на сервере: $DEST =="
ssh -p "$PORT" "$SERVER" "mkdir -p '$DEST'"

echo "== Заливка файлов =="
scp -P "$PORT" "$ROOT/game.html"         "$SERVER:$DEST/game.html"
scp -P "$PORT" "$ROOT/editor.html"       "$SERVER:$DEST/editor.html"
scp -P "$PORT" "$ROOT/deploy/index.html" "$SERVER:$DEST/index.html"

echo
echo "== Готово =="
echo "  /  и  /game.html   — игра"
echo "  /editor.html       — редактор уровней"
