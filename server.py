#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Encuentro en Salud — servidor de desarrollo (solo librería estándar).

- Sirve la app estática desde ./app
- API de autenticación con roles (user / admin), contraseñas PBKDF2,
  sesiones con cookie HttpOnly + SameSite, rate-limit de login.
- El administrador ve la ubicación de los usuarios registrados en tiempo real
  (Server-Sent Events en /api/stream).

Ejecución:  python3 server.py            (puerto 8791, o PORT=xxxx)
Admin:      se crea admin@colsanitas.com al primer arranque; la contraseña se
            toma de la variable de entorno ADMIN_PASS o se genera aleatoria y
            se imprime UNA vez en consola. Si ADMIN_PASS está definida al
            arrancar, la contraseña del admin se restablece a ese valor.
"""
import json
import os
import queue
import re
import secrets
import sqlite3
import threading
import time
import hashlib
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import functools
print = functools.partial(print, flush=True)

BASE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(BASE, 'app')
# DATA_DIR: en Render, montar un disco persistente (p. ej. /var/data) para
# conservar usuarios y caché de fotos entre despliegues.
DATA_DIR = os.environ.get('DATA_DIR', BASE)
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, 'encuentro.db')
PORT = int(os.environ.get('PORT', '8791'))
HOST = os.environ.get('HOST', '127.0.0.1')          # en Render: 0.0.0.0
COOKIE_SECURE = os.environ.get('COOKIE_SECURE') == '1'  # en Render: 1 (HTTPS)
TRUST_PROXY = os.environ.get('TRUST_PROXY') == '1'  # en Render: 1 (X-Forwarded-For)

SESSION_TTL = 12 * 3600          # 12 horas
PBKDF2_ITERS = 200_000
MAX_BODY = 200_000               # 200 KB (el avatar 3D viaja como PNG base64)
LOGIN_MAX_FAILS = 5              # por IP+correo
LOGIN_WINDOW = 600               # 10 minutos

EMAIL_RE = re.compile(r'^[^@\s]{1,64}@[^@\s]{1,190}\.[a-zA-Z]{2,24}$')

# --- Bogotá aprox. para validar coordenadas reportadas ---
LAT_MIN, LAT_MAX = 3.5, 5.6
LNG_MIN, LNG_MAX = -75.0, -73.4

# --- Google Routes API (opcional). La clave SOLO vive en el servidor. ---
GOOGLE_KEY = os.environ.get('GOOGLE_MAPS_API_KEY', '').strip()
ROUTE_CACHE_TTL = 120            # seg: cachear matrices para controlar costos
MAX_DESTINATIONS = 100           # límite de TRAFFIC_AWARE en computeRouteMatrix

# --- Modo de uso de Google (control de costos) ---
#   seleccion: lista con modelo local; Google solo para el punto seleccionado
#              y las fotos. Cabe en la franja gratuita mensual. (por defecto)
#   top:       ademas, matriz con trafico real para los GOOGLE_TOP_N mas cercanos
#   completo:  matriz para los 92 sitios en cada consulta (el mas costoso)
GOOGLE_MODE = os.environ.get('GOOGLE_MODE', 'seleccion').strip().lower()
if GOOGLE_MODE not in ('seleccion', 'top', 'completo'):
    GOOGLE_MODE = 'seleccion'
GOOGLE_TOP_N = max(1, min(50, int(os.environ.get('GOOGLE_TOP_N', '10'))))

# Presupuesto diario de llamadas a Google (tope duro, se reinicia cada dia)
CAP_RUTAS = int(os.environ.get('GOOGLE_CAP_RUTAS', '150'))        # computeRoutes/dia
CAP_ELEMENTOS = int(os.environ.get('GOOGLE_CAP_ELEMENTOS', '2000'))  # elementos matriz/dia
CAP_FOTOS = int(os.environ.get('GOOGLE_CAP_FOTOS', '120'))        # busquedas de foto/dia

_budget = {'day': '', 'route': 0, 'elem': 0, 'photo': 0}


def budget_take(kind, amount, cap):
    """Descuenta del presupuesto diario; False si el tope se agotaria."""
    with _lock:
        today = time.strftime('%Y-%m-%d')
        if _budget['day'] != today:
            _budget.update({'day': today, 'route': 0, 'elem': 0, 'photo': 0})
        if _budget[kind] + amount > cap:
            return False
        _budget[kind] += amount
        return True

CSP = (
    "default-src 'self'; "
    "script-src 'self' https://unpkg.com; "
    "style-src 'self' https://unpkg.com https://fonts.googleapis.com 'unsafe-inline'; "
    "font-src https://fonts.gstatic.com; "
    "img-src 'self' data: https://*.tile.openstreetmap.org; "
    "connect-src 'self' https://nominatim.openstreetmap.org; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)

# ============================================================
# Base de datos
# ============================================================
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def hash_pass(password, salt_hex):
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'),
                             bytes.fromhex(salt_hex), PBKDF2_ITERS)
    return dk.hex()


def set_password(conn, email, password):
    salt = secrets.token_hex(16)
    conn.execute('UPDATE users SET salt=?, pass_hash=? WHERE email=?',
                 (salt, hash_pass(password, salt), email))


def create_user(conn, email, name, password, role='user'):
    salt = secrets.token_hex(16)
    conn.execute(
        'INSERT INTO users(email, name, pass_hash, salt, role) VALUES(?,?,?,?,?)',
        (email, name, hash_pass(password, salt), salt, role))


def init_db():
    with db() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS users(
            email TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            pass_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            avatar TEXT,
            avatar_img TEXT,
            lat REAL, lng REAL, label TEXT,
            updated_at REAL)''')
        admin = c.execute("SELECT email FROM users WHERE role='admin'").fetchone()
        env_pass = os.environ.get('ADMIN_PASS')
        if not admin:
            pwd = env_pass or secrets.token_urlsafe(10)
            create_user(c, 'admin@colsanitas.com', 'Administrador', pwd, 'admin')
            print('=' * 62)
            print('  ADMIN CREADO ->  admin@colsanitas.com')
            print('  Contraseña   ->  %s' % pwd)
            print('  (guárdala; no se volverá a mostrar. Puedes fijarla con')
            print('   la variable de entorno ADMIN_PASS al arrancar)')
            print('=' * 62)
        elif env_pass:
            set_password(c, 'admin@colsanitas.com', env_pass)
            print('[i] Contraseña del admin restablecida desde ADMIN_PASS')
        if not c.execute("SELECT email FROM users WHERE email='demo@colsanitas.com'").fetchone():
            create_user(c, 'demo@colsanitas.com', 'Usuario Demo', 'demo123', 'user')
            print('[i] Usuario demo: demo@colsanitas.com / demo123 (solo desarrollo)')
        # migraciones: consentimientos (Ley 1581/2012) y precision del GPS
        for col in ('consent_at REAL', 'loc_consent_at REAL', 'accuracy REAL'):
            try:
                c.execute('ALTER TABLE users ADD COLUMN ' + col)
            except sqlite3.OperationalError:
                pass
        # cuentas internas de prueba: consentimiento implicito
        c.execute("UPDATE users SET consent_at=COALESCE(consent_at, ?), loc_consent_at=COALESCE(loc_consent_at, ?) "
                  "WHERE email IN ('demo@colsanitas.com', 'admin@colsanitas.com')",
                  (time.time(), time.time()))


def public_user(row):
    """Campos de un usuario que puede ver el admin (nunca hash/salt)."""
    avatar = None
    try:
        avatar = json.loads(row['avatar']) if row['avatar'] else None
    except Exception:
        pass
    return {
        'email': row['email'], 'name': row['name'], 'role': row['role'],
        'lat': row['lat'], 'lng': row['lng'], 'label': row['label'],
        'updatedAt': row['updated_at'], 'avatar': avatar,
        'avatarImg': row['avatar_img'],
        'accuracy': row['accuracy'],
        'locConsent': bool(row['loc_consent_at']),
    }


# ============================================================
# Sesiones, rate-limit y pub/sub SSE (en memoria)
# ============================================================
_lock = threading.Lock()
_sessions = {}      # token -> {email, expires}
_fails = {}         # 'ip|email' -> [timestamps]
_subs = set()       # queue.Queue de cada admin conectado por SSE


def session_create(email):
    token = secrets.token_urlsafe(32)
    with _lock:
        _sessions[token] = {'email': email, 'expires': time.time() + SESSION_TTL}
    return token


def session_get(token):
    with _lock:
        s = _sessions.get(token)
        if not s:
            return None
        if s['expires'] < time.time():
            del _sessions[token]
            return None
        return s['email']


def session_drop(token):
    with _lock:
        _sessions.pop(token, None)


def login_blocked(ip, email):
    key = ip + '|' + email
    now = time.time()
    with _lock:
        ts = [t for t in _fails.get(key, []) if now - t < LOGIN_WINDOW]
        _fails[key] = ts
        return len(ts) >= LOGIN_MAX_FAILS


def login_failed(ip, email):
    with _lock:
        _fails.setdefault(ip + '|' + email, []).append(time.time())


def publish(event):
    data = json.dumps(event, ensure_ascii=False)
    with _lock:
        for q in list(_subs):
            try:
                q.put_nowait(data)
            except Exception:
                pass


# ============================================================
# Google Routes API (proxy en servidor; la clave nunca sale de aquí)
# ============================================================
_route_cache = {}  # key -> (ts, data)


def google_post(url, payload, fieldmask):
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        'X-Goog-FieldMask': fieldmask,
    })
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.loads(r.read().decode('utf-8'))


def parse_departure(ms):
    """Epoch ms del cliente -> RFC3339 futuro (Google exige salida >= ahora)."""
    now = time.time()
    try:
        t = float(ms) / 1000.0
    except (TypeError, ValueError):
        t = 0
    if t < now + 30:
        t = now + 60
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def waypoint(lat, lng):
    return {'waypoint': {'location': {'latLng': {'latitude': lat, 'longitude': lng}}}}


def in_bogota(lat, lng):
    return LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX


def google_matrix(olat, olng, dests, mode, departure_ms):
    """Matriz 1 origen x N destinos. Devuelve [{i, sec, m}] o lanza excepción."""
    bucket = int(time.time() // ROUTE_CACHE_TTL)
    key = '%0.4f,%0.4f|%s|%s|%d|%d' % (olat, olng, mode, bool(departure_ms), len(dests), bucket)
    with _lock:
        hit = _route_cache.get(key)
        if hit:
            return hit[1]
    payload = {
        'origins': [waypoint(olat, olng)],
        'destinations': [waypoint(a, b) for a, b in dests],
        'travelMode': 'WALK' if mode == 'caminando' else 'DRIVE',
    }
    if payload['travelMode'] == 'DRIVE':
        payload['routingPreference'] = 'TRAFFIC_AWARE'
        payload['departureTime'] = parse_departure(departure_ms)
    rows = google_post(
        'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
        payload, 'originIndex,destinationIndex,duration,distanceMeters,condition')
    out = []
    for r in rows:
        if r.get('condition') != 'ROUTE_EXISTS':
            continue
        sec = int(str(r.get('duration', '0s')).rstrip('s') or 0)
        out.append({'i': r.get('destinationIndex', 0), 'sec': sec,
                    'm': r.get('distanceMeters', 0)})
    with _lock:
        _route_cache[key] = (time.time(), out)
        if len(_route_cache) > 200:   # limpieza simple
            for k in sorted(_route_cache, key=lambda k: _route_cache[k][0])[:100]:
                del _route_cache[k]
    return out


PHOTO_DIR = os.path.join(DATA_DIR, '.photo_cache')
PHOTO_KEY_RE = re.compile(r'^[DP]\d{1,6}$')


def google_place_photo(pkey, query):
    """Foto del lugar vía Places API, con caché en disco (una consulta por sitio)."""
    os.makedirs(PHOTO_DIR, exist_ok=True)
    jpg = os.path.join(PHOTO_DIR, pkey + '.jpg')
    none = os.path.join(PHOTO_DIR, pkey + '.none')
    if os.path.exists(jpg):
        with open(jpg, 'rb') as f:
            return f.read()
    if os.path.exists(none):
        return None
    url = ('https://maps.googleapis.com/maps/api/place/findplacefromtext/json'
           '?input=%s&inputtype=textquery&fields=photos'
           '&locationbias=circle:30000@4.65,-74.09&key=%s'
           % (urllib.parse.quote(query), GOOGLE_KEY))
    with urllib.request.urlopen(url, timeout=8) as r:
        data = json.loads(r.read().decode('utf-8'))
    status = data.get('status')
    if status not in ('OK', 'ZERO_RESULTS'):
        # error de clave/cuota: NO cachear como "sin foto"
        raise RuntimeError('Places status: %s %s' % (status, data.get('error_message', '')))
    cands = data.get('candidates') or []
    photos = (cands[0].get('photos') if cands else None) or []
    if not photos:
        open(none, 'w').close()   # caché negativa: no repetir la búsqueda
        return None
    purl = ('https://maps.googleapis.com/maps/api/place/photo'
            '?maxwidth=520&photo_reference=%s&key=%s'
            % (photos[0]['photo_reference'], GOOGLE_KEY))
    with urllib.request.urlopen(purl, timeout=10) as r:
        img = r.read()
    if not img or len(img) > 3_000_000:
        open(none, 'w').close()
        return None
    with open(jpg, 'wb') as f:
        f.write(img)
    return img


def google_route(olat, olng, dlat, dlng, mode, departure_ms):
    """Ruta única con polilínea para dibujar en el mapa."""
    payload = {
        'origin': {'location': {'latLng': {'latitude': olat, 'longitude': olng}}},
        'destination': {'location': {'latLng': {'latitude': dlat, 'longitude': dlng}}},
        'travelMode': 'WALK' if mode == 'caminando' else 'DRIVE',
    }
    if payload['travelMode'] == 'DRIVE':
        payload['routingPreference'] = 'TRAFFIC_AWARE'
        payload['departureTime'] = parse_departure(departure_ms)
    data = google_post(
        'https://routes.googleapis.com/directions/v2:computeRoutes',
        payload, 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline')
    routes = data.get('routes') or []
    if not routes:
        return None
    r = routes[0]
    return {
        'sec': int(str(r.get('duration', '0s')).rstrip('s') or 0),
        'm': r.get('distanceMeters', 0),
        'polyline': (r.get('polyline') or {}).get('encodedPolyline', ''),
    }


# ============================================================
# Handler HTTP
# ============================================================
class Handler(SimpleHTTPRequestHandler):

    # ---------- utilidades ----------
    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _json(self, code, obj, set_cookie=None, clear_cookie=False):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        extra = '; Secure' if COOKIE_SECURE else ''
        if set_cookie:
            self.send_header('Set-Cookie',
                             'es_session=%s; HttpOnly; SameSite=Strict; Path=/; Max-Age=%d%s'
                             % (set_cookie, SESSION_TTL, extra))
        if clear_cookie:
            self.send_header('Set-Cookie', 'es_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + extra)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return None
        if n <= 0 or n > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            return None

    def _token(self):
        raw = self.headers.get('Cookie', '')
        for part in raw.split(';'):
            k, _, v = part.strip().partition('=')
            if k == 'es_session':
                return v
        return None

    def _user(self):
        token = self._token()
        if not token:
            return None
        email = session_get(token)
        if not email:
            return None
        with db() as c:
            return c.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()

    def log_message(self, fmt, *args):
        # log sin datos sensibles (nunca cuerpos de petición)
        print('[http] %s - %s' % (self.address_string(), fmt % args))

    # ---------- GET ----------
    def do_GET(self):
        path = self.path.split('?', 1)[0]
        if path == '/api/me':
            u = self._user()
            if not u:
                return self._json(401, {'error': 'no-session'})
            return self._json(200, {'user': public_user(u)})
        if path == '/api/config':
            u = self._user()
            if not u:
                return self._json(401, {'error': 'no-session'})
            return self._json(200, {'googleRoutes': bool(GOOGLE_KEY),
                                    'mode': GOOGLE_MODE, 'topN': GOOGLE_TOP_N})
        if path == '/api/users':
            u = self._user()
            if not u or u['role'] != 'admin':
                return self._json(403, {'error': 'solo-admin'})
            with db() as c:
                rows = c.execute('SELECT * FROM users ORDER BY updated_at IS NULL, updated_at DESC').fetchall()
            return self._json(200, {'users': [public_user(r) for r in rows]})
        if path == '/api/stream':
            return self._stream()
        if path == '/api/photo':
            return self._photo()
        return super().do_GET()

    def _photo(self):
        u = self._user()
        if not u:
            return self._json(401, {'error': 'no-session'})
        if not GOOGLE_KEY:
            return self._json(501, {'error': 'google-no-configurado'})
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        pkey = (qs.get('key') or [''])[0]
        query = (qs.get('q') or [''])[0][:220]
        if not PHOTO_KEY_RE.match(pkey) or len(query) < 5:
            return self._json(400, {'error': 'parametros-invalidos'})
        # el presupuesto solo se descuenta si la foto no está ya en caché
        en_cache = (os.path.exists(os.path.join(PHOTO_DIR, pkey + '.jpg')) or
                    os.path.exists(os.path.join(PHOTO_DIR, pkey + '.none')))
        if not en_cache and not budget_take('photo', 1, CAP_FOTOS):
            return self._json(429, {'error': 'presupuesto-diario-agotado'})
        try:
            img = google_place_photo(pkey, query)
        except urllib.error.HTTPError as e:
            print('[google] HTTP %s en photo: %s' % (e.code, e.read()[:200]))
            return self._json(502, {'error': 'google-error'})
        except Exception as e:
            print('[google] error photo: %s' % e)
            return self._json(502, {'error': 'google-error'})
        if not img:
            return self._json(404, {'error': 'sin-foto'})
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('Content-Length', str(len(img)))
        self.end_headers()
        self.wfile.write(img)

    def _stream(self):
        u = self._user()
        if not u or u['role'] != 'admin':
            return self._json(403, {'error': 'solo-admin'})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()
        q = queue.Queue(maxsize=100)
        with _lock:
            _subs.add(q)
        try:
            self.wfile.write(b': conectado\n\n')
            self.wfile.flush()
            while True:
                try:
                    data = q.get(timeout=20)
                    self.wfile.write(('data: %s\n\n' % data).encode('utf-8'))
                except queue.Empty:
                    self.wfile.write(b': ping\n\n')
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _lock:
                _subs.discard(q)

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split('?', 1)[0]
        body = self._body()
        if body is None:
            return self._json(400, {'error': 'cuerpo-invalido'})

        if path == '/api/register':
            return self._register(body)
        if path == '/api/login':
            return self._login(body)
        if path == '/api/logout':
            token = self._token()
            if token:
                email = session_get(token)
                session_drop(token)
                if email:
                    # privacidad: al cerrar sesión, el usuario deja de ser ubicable
                    with db() as c:
                        c.execute('UPDATE users SET lat=NULL, lng=NULL, label=NULL, '
                                  'accuracy=NULL, updated_at=? WHERE email=?',
                                  (time.time(), email))
                        row = c.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
                    if row:
                        publish({'type': 'user-update', 'user': public_user(row)})
            return self._json(200, {'ok': True}, clear_cookie=True)

        # --- rutas autenticadas ---
        u = self._user()
        if not u:
            return self._json(401, {'error': 'no-session'})

        if path == '/api/location':
            try:
                lat, lng = float(body.get('lat')), float(body.get('lng'))
            except (TypeError, ValueError):
                return self._json(400, {'error': 'coordenadas-invalidas'})
            if not (LAT_MIN <= lat <= LAT_MAX and LNG_MIN <= lng <= LNG_MAX):
                return self._json(400, {'error': 'fuera-de-bogota'})
            if not u['loc_consent_at']:
                return self._json(403, {'error': 'sin-consentimiento-ubicacion'})
            label = str(body.get('label') or '')[:200]
            acc = None
            try:
                a = float(body.get('accuracy'))
                if 0 < a < 10000:
                    acc = a
            except (TypeError, ValueError):
                pass
            with db() as c:
                c.execute('UPDATE users SET lat=?, lng=?, label=?, accuracy=?, updated_at=? WHERE email=?',
                          (lat, lng, label, acc, time.time(), u['email']))
                row = c.execute('SELECT * FROM users WHERE email=?', (u['email'],)).fetchone()
            publish({'type': 'user-update', 'user': public_user(row)})
            return self._json(200, {'ok': True})

        if path == '/api/routes':
            # Matriz de tiempos/distancias reales (proxy a Google, con caché)
            if not GOOGLE_KEY:
                return self._json(501, {'error': 'google-no-configurado'})
            if GOOGLE_MODE == 'seleccion':
                return self._json(403, {'error': 'modo-seleccion'})
            try:
                olat, olng = float(body.get('lat')), float(body.get('lng'))
            except (TypeError, ValueError):
                return self._json(400, {'error': 'coordenadas-invalidas'})
            dests_raw = body.get('destinations')
            if not isinstance(dests_raw, list) or not dests_raw or len(dests_raw) > MAX_DESTINATIONS:
                return self._json(400, {'error': 'destinos-invalidos'})
            dests = []
            try:
                for d in dests_raw:
                    a, b = float(d[0]), float(d[1])
                    if not in_bogota(a, b):
                        return self._json(400, {'error': 'destino-fuera-de-bogota'})
                    dests.append((a, b))
            except (TypeError, ValueError, IndexError):
                return self._json(400, {'error': 'destinos-invalidos'})
            if not in_bogota(olat, olng):
                return self._json(400, {'error': 'fuera-de-bogota'})
            mode = 'caminando' if body.get('mode') == 'caminando' else 'carro'
            limit = GOOGLE_TOP_N if GOOGLE_MODE == 'top' else MAX_DESTINATIONS
            dests = dests[:limit]
            if not budget_take('elem', len(dests), CAP_ELEMENTOS):
                return self._json(429, {'error': 'presupuesto-diario-agotado'})
            try:
                results = google_matrix(olat, olng, dests, mode, body.get('departure'))
                return self._json(200, {'results': results})
            except urllib.error.HTTPError as e:
                print('[google] HTTP %s en matrix: %s' % (e.code, e.read()[:300]))
                return self._json(502, {'error': 'google-error'})
            except Exception as e:
                print('[google] error matrix: %s' % e)
                return self._json(502, {'error': 'google-error'})

        if path == '/api/route':
            # Ruta única con polilínea para el punto seleccionado
            if not GOOGLE_KEY:
                return self._json(501, {'error': 'google-no-configurado'})
            try:
                olat, olng = float(body.get('olat')), float(body.get('olng'))
                dlat, dlng = float(body.get('dlat')), float(body.get('dlng'))
            except (TypeError, ValueError):
                return self._json(400, {'error': 'coordenadas-invalidas'})
            if not (in_bogota(olat, olng) and in_bogota(dlat, dlng)):
                return self._json(400, {'error': 'fuera-de-bogota'})
            mode = 'caminando' if body.get('mode') == 'caminando' else 'carro'
            if not budget_take('route', 1, CAP_RUTAS):
                return self._json(429, {'error': 'presupuesto-diario-agotado'})
            try:
                r = google_route(olat, olng, dlat, dlng, mode, body.get('departure'))
                if not r:
                    return self._json(404, {'error': 'sin-ruta'})
                return self._json(200, r)
            except urllib.error.HTTPError as e:
                print('[google] HTTP %s en route: %s' % (e.code, e.read()[:300]))
                return self._json(502, {'error': 'google-error'})
            except Exception as e:
                print('[google] error route: %s' % e)
                return self._json(502, {'error': 'google-error'})

        if path == '/api/consent':
            # el usuario autoriza compartir su ubicacion en tiempo real
            if body.get('location') is not True:
                return self._json(400, {'error': 'consentimiento-invalido'})
            with db() as c:
                c.execute('UPDATE users SET loc_consent_at=? WHERE email=?', (time.time(), u['email']))
            return self._json(200, {'ok': True})

        if path == '/api/avatar':
            cfg = body.get('cfg')
            img = body.get('img')
            if not isinstance(cfg, dict) or len(json.dumps(cfg)) > 2000:
                return self._json(400, {'error': 'avatar-invalido'})
            if img is not None:
                if not (isinstance(img, str) and img.startswith('data:image/png;base64,')
                        and len(img) < 150_000):
                    return self._json(400, {'error': 'imagen-invalida'})
            with db() as c:
                c.execute('UPDATE users SET avatar=?, avatar_img=?, updated_at=? WHERE email=?',
                          (json.dumps(cfg), img, time.time(), u['email']))
                row = c.execute('SELECT * FROM users WHERE email=?', (u['email'],)).fetchone()
            publish({'type': 'user-update', 'user': public_user(row)})
            return self._json(200, {'ok': True})

        return self._json(404, {'error': 'no-existe'})

    # ---------- auth ----------
    def _register(self, body):
        email = str(body.get('email') or '').strip().lower()
        name = str(body.get('name') or '').strip()[:80]
        password = str(body.get('pass') or '')
        if not EMAIL_RE.match(email):
            return self._json(400, {'error': 'Correo inválido.'})
        if len(name) < 2:
            return self._json(400, {'error': 'Escribe tu nombre completo.'})
        if len(password) < 8:
            return self._json(400, {'error': 'La contraseña debe tener al menos 8 caracteres.'})
        if body.get('consent') is not True:
            return self._json(400, {'error': 'Debes aceptar la política de tratamiento de datos para registrarte.'})
        try:
            with db() as c:
                create_user(c, email, name, password, 'user')  # el rol NUNCA viene del cliente
                c.execute('UPDATE users SET consent_at=? WHERE email=?', (time.time(), email))
                row = c.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        except sqlite3.IntegrityError:
            return self._json(409, {'error': 'Ese correo ya está registrado.'})
        publish({'type': 'user-update', 'user': public_user(row)})
        token = session_create(email)
        return self._json(200, {'user': public_user(row)}, set_cookie=token)

    def _client_ip(self):
        if TRUST_PROXY:
            fwd = self.headers.get('X-Forwarded-For', '')
            if fwd:
                return fwd.split(',')[0].strip()
        return self.client_address[0]

    def _login(self, body):
        email = str(body.get('email') or '').strip().lower()
        password = str(body.get('pass') or '')
        ip = self._client_ip()
        if login_blocked(ip, email):
            return self._json(429, {'error': 'Demasiados intentos. Espera 10 minutos.'})
        with db() as c:
            row = c.execute('SELECT * FROM users WHERE email=?', (email,)).fetchone()
        ok = bool(row) and secrets.compare_digest(row['pass_hash'], hash_pass(password, row['salt'] if row else '00'))
        if not ok:
            login_failed(ip, email)
            return self._json(401, {'error': 'Correo o contraseña incorrectos.'})
        token = session_create(email)
        return self._json(200, {'user': public_user(row)}, set_cookie=token)


def main():
    init_db()
    handler = partial(Handler, directory=APP_DIR)
    srv = ThreadingHTTPServer((HOST, PORT), handler)
    print('[i] Encuentro en Salud -> http://%s:%d' % (HOST, PORT))
    if GOOGLE_KEY:
        print('[i] Google Routes API: ACTIVA · modo "%s"' % GOOGLE_MODE)
        print('[i] Presupuesto diario: %d rutas · %d elementos de matriz · %d fotos'
              % (CAP_RUTAS, CAP_ELEMENTOS, CAP_FOTOS))
    else:
        print('[i] Google Routes API: no configurada (se usa el modelo heurístico).')
        print('    Actívala con:  GOOGLE_MAPS_API_KEY="tu-clave" python3 server.py')
    srv.serve_forever()


if __name__ == '__main__':
    main()
