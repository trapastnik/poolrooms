#!/usr/bin/env python3
"""
Таблица результатов POOLROOMS.

Намеренно крошечная и без зависимостей: стандартной библиотеки хватает, а
меньше кода — меньше того, что может сломаться на чужом сервере. Данные лежат
в одном JSON-файле под блокировкой; при десятке игроков не одновременно этого
более чем достаточно.

Оговорка по существу: счёт присылает клиент, проверить его сервер не может —
это игра целиком в браузере. Ограничения ниже отсекают мусор и спам, но не
защищают от того, кто целенаправленно подделает запрос.
"""
import hashlib
import hmac
import urllib.error
import urllib.request
import json
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DATA = os.environ.get('SCORES_FILE', '/data/scores.json')
KEEP = 50                  # сколько строк храним
TOP = 20                   # сколько отдаём
MAX_SCORE = 10_000_000
POST_PER_HOUR = 40         # с одного адреса
BAD_PIN_PER_HOUR = 12      # неудачных попыток PIN с одного адреса
PBKDF_ROUNDS = 120_000
# Токен владельца для очистки таблицы. Если не задан — чистить нельзя вообще:
# безопасный отказ лучше, чем случайно открытая всем ручка.
ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
# PIN для просмотра статистики. Пусто — панель закрыта совсем (fail-safe, как
# у ADMIN_TOKEN): лучше отказать всем, чем открыть всем при незаданной
# переменной. Значение задаётся в .env на сервере, в коде его нет.
STATS_PIN = os.environ.get('STATS_PIN', '')
# Сколько доверенных прокси-хопов стоит перед нами. Реальный адрес клиента —
# это TRUSTED_HOPS-й элемент X-Forwarded-For С КОНЦА (его добавил самый внешний
# наш прокси). Левые элементы клиент присылает сам и может подделать.
TRUSTED_HOPS = max(1, int(os.environ.get('TRUSTED_HOPS', '2')))
ONLINE_WINDOW = 75         # секунд без сигнала — считаем, что игрок вышел
PING_MAX = 400             # максимум отслеживаемых сессий
PIN_RE = re.compile(r'^\d{4}$')

_lock = threading.Lock()
_recent = defaultdict(deque)
_bad_pin = defaultdict(deque)
_online = {}               # sid -> {name, ts}; живёт только в памяти
_bad_name = re.compile(r'[^\w \-.@]', re.UNICODE)


DAYS_KEEP = 60             # столько дней истории держим


def _load():
    """Вернуть (строки, пользователи, счётчики). Старый формат тоже читаем."""
    try:
        with open(DATA, 'r', encoding='utf-8') as f:
            db = json.load(f)
    except (OSError, ValueError):
        return [], {}, {}
    if isinstance(db, list):
        return db, {}, {}
    if not isinstance(db, dict):
        return [], {}, {}
    rows = db.get('rows')
    users = db.get('users')
    stats = db.get('stats')
    return (rows if isinstance(rows, list) else []), \
           (users if isinstance(users, dict) else {}), \
           (stats if isinstance(stats, dict) else {})


def _save(rows, users, stats):
    tmp = DATA + '.tmp'
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'rows': rows, 'users': users, 'stats': stats}, f, ensure_ascii=False)
    os.replace(tmp, DATA)          # атомарно: файл не остаётся обрезанным


def _bump(stats):
    """Засчитать забег: всего и в разбивке по дням (старое подчищаем)."""
    stats['total'] = int(stats.get('total', 0)) + 1
    days = stats.get('days')
    if not isinstance(days, dict):
        days = {}
    key = time.strftime('%Y-%m-%d', time.gmtime())
    days[key] = int(days.get(key, 0)) + 1
    for k in sorted(days)[:-DAYS_KEEP]:
        days.pop(k, None)
    stats['days'] = days
    return stats


def _realtime():
    """Состояние ретранслятора. Спрашиваем изнутри сети, наружу его не открываем."""
    url = os.environ.get('REALTIME_URL', 'http://realtime:8000/health')
    try:
        with urllib.request.urlopen(url, timeout=1.5) as r:
            return json.loads(r.read().decode('utf-8'))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return {'ok': False}


def _host():
    """Нагрузка машины. Читаем /proc — в контейнере он показывает хост."""
    out = {'cpus': os.cpu_count() or 1}
    try:
        with open('/proc/loadavg') as f:
            p = f.read().split()
        out['load'] = [float(p[0]), float(p[1]), float(p[2])]
    except (OSError, ValueError, IndexError):
        pass
    try:
        mem = {}
        with open('/proc/meminfo') as f:
            for line in f:
                k, _, v = line.partition(':')
                mem[k] = int(v.strip().split()[0])       # килобайты
        total, avail = mem.get('MemTotal', 0), mem.get('MemAvailable', 0)
        if total:
            out['memTotalMb'] = total // 1024
            out['memUsedMb'] = (total - avail) // 1024
    except (OSError, ValueError, IndexError):
        pass
    try:
        st = os.statvfs('/data')
        out['diskFreeGb'] = round(st.f_bavail * st.f_frsize / 1e9, 1)
        out['diskTotalGb'] = round(st.f_blocks * st.f_frsize / 1e9, 1)
    except OSError:
        pass
    try:
        with open('/proc/uptime') as f:
            out['uptimeH'] = round(float(f.read().split()[0]) / 3600, 1)
    except (OSError, ValueError, IndexError):
        pass
    return out


def _hash_pin(pin, salt_hex):
    """PIN в открытом виде не хранится нигде — только это значение."""
    return hashlib.pbkdf2_hmac('sha256', pin.encode('utf-8'),
                               bytes.fromhex(salt_hex), PBKDF_ROUNDS).hex()


def _check_or_register(users, name, pin):
    """
    Имя закрепляется за первым, кто его занял. Дальше нужен тот же PIN.
    Возвращает True, если имя выдано этому игроку.
    """
    rec = users.get(name)
    if rec is None:
        salt = secrets.token_hex(16)
        users[name] = {'salt': salt, 'hash': _hash_pin(pin, salt), 'since': int(time.time())}
        return True
    return hmac.compare_digest(rec.get('hash', ''), _hash_pin(pin, rec.get('salt', '')))


def _clean(raw):
    """Привести присланное к нашему виду или отвергнуть. PIN сюда не попадает."""
    if not isinstance(raw, dict):
        return None
    name = _bad_name.sub('', str(raw.get('name', '')).strip())[:18] or 'без имени'
    try:
        score = int(raw.get('score', 0))
        kills = int(raw.get('kills', 0))
        arts = int(raw.get('artifacts', 0))
        secs = int(raw.get('time', 0))
    except (TypeError, ValueError):
        return None
    if not (0 <= score <= MAX_SCORE and 0 <= kills <= 100_000
            and 0 <= arts <= 100_000 and 0 <= secs <= 86_400):
        return None
    diff = str(raw.get('diff', ''))[:12]
    return {'name': name, 'score': score, 'kills': kills, 'artifacts': arts,
            'time': secs, 'diff': diff, 'ts': int(time.time())}


def _rate_ok(ip):
    now = time.time()
    q = _recent[ip]
    while q and now - q[0] > 3600:
        q.popleft()
    if len(q) >= POST_PER_HOUR:
        return False
    q.append(now)
    return True


def _attempts_ok(ip):
    now = time.time()
    q = _bad_pin[ip]
    while q and now - q[0] > 3600:
        q.popleft()
    return len(q) < BAD_PIN_PER_HOUR


def _note_bad_pin(ip):
    _bad_pin[ip].append(time.time())


def _prune_online(now):
    for sid in [k for k, v in _online.items() if now - v['ts'] > ONLINE_WINDOW]:
        _online.pop(sid, None)


def _touch_online(sid, name):
    now = time.time()
    _prune_online(now)
    if sid not in _online and len(_online) >= PING_MAX:
        return
    _online[sid] = {'name': name, 'ts': now}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'poolrooms-scores'

    def _send(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _client_ip(self):
        # Берём НЕ первый элемент цепочки, а TRUSTED_HOPS-й с конца. Первые
        # элементы X-Forwarded-For клиент присылает сам: если считать по ним,
        # любой лимит обходится подстановкой случайного адреса. Адрес, который
        # добавил наш крайний прокси, подделать нельзя. Цепочка короче ожидаемой
        # (кто-то пришёл в обход прокси) — падаем на адрес сокета: он безопасен,
        # общий для всех таких запросов, то есть лимит только жёстче.
        parts = [p.strip() for p in self.headers.get('X-Forwarded-For', '').split(',') if p.strip()]
        if len(parts) >= TRUSTED_HOPS:
            return parts[-TRUSTED_HOPS]
        return self.client_address[0]

    def do_GET(self):
        path = self.path.rstrip('/')
        if path == '/stats':
            return self._stats()
        if path == '/players':
            # только имена: по ним человек узнаёт себя в списке при входе.
            # Ни хешей, ни счёта здесь нет.
            with _lock:
                _, users, _st = _load()
            names = sorted(users.keys(), key=lambda n: -users[n].get('since', 0))
            return self._send(200, {'players': names[:60]})
        if path not in ('/scores', ''):
            return self._send(404, {'error': 'not found'})
        with _lock:
            rows, _, _st = _load()
        self._send(200, {'rows': rows[:TOP]})

    def _stats(self):
        """Кто сейчас в игре. За PIN — чтобы список имён не был публичным."""
        ip = self._client_ip()
        if not _attempts_ok(ip):
            return self._send(429, {'error': 'too many'})
        if not STATS_PIN or not hmac.compare_digest(self.headers.get('X-Stats-Pin', ''), STATS_PIN):
            _note_bad_pin(ip)
            return self._send(403, {'error': 'forbidden'})
        now = time.time()
        with _lock:
            _prune_online(now)
            players = sorted(
                ({'name': v['name'], 'idle': int(now - v['ts'])} for v in _online.values()),
                key=lambda r: r['idle'])
            rows, users, stats = _load()
        days = stats.get('days') or {}
        self._send(200, {
            'online': len(players),
            'players': players[:40],
            'runs': len(rows),                       # строк в таблице рекордов
            'total': int(stats.get('total', 0)),     # забегов вообще
            'days': {k: days[k] for k in sorted(days)[-30:]},
            'registered': len(users),
            'best': rows[0]['score'] if rows else 0,
            'host': _host(),
            'net': _realtime()
        })

    def do_DELETE(self):
        """Очистка таблицы — только для владельца, по токену из окружения."""
        if self.path.rstrip('/') != '/scores':
            return self._send(404, {'error': 'not found'})
        token = self.headers.get('X-Admin-Token', '')
        if not ADMIN_TOKEN or not hmac.compare_digest(token, ADMIN_TOKEN):
            return self._send(403, {'error': 'forbidden'})
        keep_users = self.headers.get('X-Keep-Users', '1') != '0'
        with _lock:
            _, users, stats = _load()
            _save([], users if keep_users else {}, stats)   # счётчики забегов не трогаем
        self._send(200, {'rows': [], 'cleared': True})

    def do_POST(self):
        path = self.path.rstrip('/')
        if path == '/ping':
            return self._ping()
        if path == '/auth':
            return self._auth()
        if path != '/scores':
            return self._send(404, {'error': 'not found'})
        if not _rate_ok(self._client_ip()):
            return self._send(429, {'error': 'too many'})
        try:
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            n = 0
        if n <= 0 or n > 4096:
            return self._send(400, {'error': 'bad size'})
        try:
            raw = json.loads(self.rfile.read(n).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {'error': 'bad json'})
        row = _clean(raw)
        if row is None:
            return self._send(400, {'error': 'bad row'})

        pin = str(raw.get('pin', ''))
        if not PIN_RE.match(pin):
            return self._send(400, {'error': 'pin must be 4 digits'})

        ip = self._client_ip()
        if not _attempts_ok(ip):
            return self._send(429, {'error': 'too many bad pins'})

        with _lock:
            rows, users, stats = _load()
            if not _check_or_register(users, row['name'], pin):
                _note_bad_pin(ip)
                return self._send(403, {'error': 'name taken'})
            rows.append(row)
            rows.sort(key=lambda r: -r.get('score', 0))
            rows = rows[:KEEP]
            _save(rows, users, _bump(stats))
            place = next((i + 1 for i, r in enumerate(rows) if r is row), 0)
        self._send(200, {'place': place, 'rows': rows[:TOP]})

    def _auth(self):
        """
        Вход: имя свободно — занимаем его этим PIN, занято — сверяем.
        Отдельно от отправки счёта, чтобы человек узнавал об ошибке сразу,
        а не в конце забега.
        """
        ip = self._client_ip()
        if not _attempts_ok(ip):
            return self._send(429, {'error': 'too many'})
        try:
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            n = 0
        if n <= 0 or n > 512:
            return self._send(400, {'error': 'bad size'})
        try:
            raw = json.loads(self.rfile.read(n).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {'error': 'bad json'})

        name = _bad_name.sub('', str(raw.get('name', '')).strip())[:18]
        pin = str(raw.get('pin', ''))
        if not name:
            return self._send(400, {'error': 'no name'})
        if not PIN_RE.match(pin):
            return self._send(400, {'error': 'pin must be 4 digits'})

        with _lock:
            rows, users, stats = _load()
            existed = name in users
            if not _check_or_register(users, name, pin):
                _note_bad_pin(ip)
                return self._send(403, {'error': 'wrong pin'})
            if not existed:
                _save(rows, users, stats)
        self._send(200, {'ok': True, 'name': name, 'registered': not existed})

    def _ping(self):
        """Сигнал «я в игре». Ничего не хранит на диске и не требует PIN."""
        try:
            n = int(self.headers.get('Content-Length', 0))
        except ValueError:
            n = 0
        if n <= 0 or n > 512:
            return self._send(400, {'error': 'bad size'})
        try:
            raw = json.loads(self.rfile.read(n).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {'error': 'bad json'})
        sid = str(raw.get('sid', ''))[:40]
        if not sid:
            return self._send(400, {'error': 'no sid'})
        name = _bad_name.sub('', str(raw.get('name', '')).strip())[:18] or 'без имени'
        _touch_online(sid, name)
        self._send(200, {'ok': True})

    def log_message(self, fmt, *args):
        pass          # не засоряем логи контейнера каждым запросом


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8000'))
    ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
