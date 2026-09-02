/* Encuentro en Salud — Bogotá
 * Login con roles (backend), mapa, autocompletar, recomendación con puntos,
 * tráfico, avatar 3D interactivo y vista de administrador en tiempo real.
 */
'use strict';

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, method, body) {
  const opt = { method: method || 'GET', headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(path, opt);
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(data.error || ('Error ' + r.status));
  return data;
}

/* ============================================================
 * 1. AUTENTICACIÓN (contra el backend, con roles)
 * ============================================================ */
let currentUser = null; // {email, name, role, avatar, ...}

let registerMode = false;
$('tab-login').addEventListener('click', () => setRegisterMode(false));
$('tab-register').addEventListener('click', () => setRegisterMode(true));

function setRegisterMode(on) {
  registerMode = on;
  $('tab-login').classList.toggle('active', !on);
  $('tab-register').classList.toggle('active', on);
  $('register-fields').classList.toggle('hidden', !on);
  $('login-submit').textContent = on ? 'Crear cuenta e ingresar' : 'Ingresar';
  $('login-error').classList.add('hidden');
}

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const errEl = $('login-error');
  errEl.classList.add('hidden');
  const email = $('login-email').value.trim().toLowerCase();
  const pass = $('login-pass').value;
  try {
    let resp;
    if (registerMode) {
      if (!$('reg-consent').checked) {
        throw new Error('Debes aceptar la política de tratamiento de datos para registrarte.');
      }
      resp = await api('/api/register', 'POST', {
        email, pass, name: $('reg-name').value.trim(), consent: true,
      });
    } else {
      resp = await api('/api/login', 'POST', { email, pass });
    }
    enterApp(resp.user);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
});

$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', 'POST', {}); } catch (e) {}
  location.reload();
});

let locConsent = false;        // el usuario autorizó compartir su ubicación
let pendingLocation = null;    // ubicación en espera de consentimiento

function showConsentModal() { $('consent-modal').classList.remove('hidden'); }

$('consent-allow').addEventListener('click', async () => {
  try { await api('/api/consent', 'POST', { location: true }); } catch (e) { return; }
  locConsent = true;
  $('consent-modal').classList.add('hidden');
  if (pendingLocation) {
    const [la, ln, lb] = pendingLocation;
    pendingLocation = null;
    setUserLocation(la, ln, lb);
  } else {
    tryGeolocate(false);
  }
});
$('consent-later').addEventListener('click', () => {
  $('consent-modal').classList.add('hidden');
  pendingLocation = null;
  $('loc-status').textContent = 'Sin permiso de ubicación: actívalo con el botón de GPS cuando quieras usar las recomendaciones.';
  $('loc-status').classList.remove('ok');
});

function enterApp(user) {
  currentUser = user;
  locConsent = !!user.locConsent;
  $('login-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  $('user-name').textContent = (user.name || user.email) + (user.role === 'admin' ? ' · ADMIN' : '');
  initAvatar();
  initApp();
  if (user.role === 'admin') initAdmin();
  setInterval(() => { fetch('/api/ping').catch(() => {}); }, 240000);
  api('/api/config').then((d) => {
    googleOn = !!d.googleRoutes;
    googleMode = d.mode || 'completo';
    googleTopN = d.topN || 10;
    updateEtaSource();
    refresh();
  }).catch(() => {});
}

/* ============================================================
 * 1c. GOOGLE ROUTES (vía backend): matriz de tiempos y rutas
 * ============================================================ */
let googleOn = false;      // el servidor tiene clave configurada
let googleMode = 'seleccion'; // seleccion | top | completo (lo decide el servidor)
let googleTopN = 10;
let gEta = null;           // {siteId: {sec, m}} tiempos reales recibidos
let gEtaKey = '';          // clave de la matriz vigente (origen+modo+hora)
let gEtaAt = 0;
let gEtaFetching = false;

function departureMs() {
  return (state.cuando === 'otra' && state.customDate)
    ? new Date(state.customDate).getTime() : null;
}

function updateEtaSource() {
  const el = $('eta-source');
  if (!el) return;
  if (googleOn && googleMode === 'seleccion') {
    el.innerHTML = 'Lista: modelo local · punto seleccionado: tiempo y ruta reales de <b>Google Maps</b> (modo prueba)';
    el.className = 'eta-source google';
  } else if (googleOn && gEta && googleMode === 'top') {
    el.innerHTML = 'Top ' + googleTopN + ' con tráfico en vivo de <b>Google Maps</b> · resto: modelo local';
    el.className = 'eta-source google';
  } else if (googleOn && gEta) {
    el.innerHTML = 'Tiempos y rutas: <b>Google Maps</b> (tráfico en vivo)';
    el.className = 'eta-source google';
  } else if (googleOn) {
    el.innerHTML = 'Google Maps configurado · esperando tu ubicación…';
    el.className = 'eta-source google';
  } else {
    el.innerHTML = 'Tiempos estimados con modelo local (sin Google Maps)';
    el.className = 'eta-source';
  }
}

function maybeFetchMatrix() {
  if (!googleOn || !state.user || gEtaFetching) return;
  const key = state.user.lat.toFixed(4) + ',' + state.user.lng.toFixed(4) +
    '|' + state.modo + '|' + (departureMs() || 'now');
  if (googleMode === 'seleccion') {
    // sin matriz: solo invalidar los tiempos por-selección si cambió el contexto
    if (key !== gEtaKey) { gEta = null; gEtaKey = key; }
    return;
  }
  if (key === gEtaKey && Date.now() - gEtaAt < 120000) return; // matriz vigente
  gEtaFetching = true;
  // en modo "top": solo los N sitios más cercanos en línea recta
  let idxs = SITES.map((_, i) => i);
  if (googleMode === 'top') {
    idxs = SITES
      .map((s, i) => ({ i, d: haversineKm(state.user.lat, state.user.lng, s.lat, s.lng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, googleTopN)
      .map((x) => x.i);
  }
  api('/api/routes', 'POST', {
    lat: state.user.lat, lng: state.user.lng,
    mode: state.modo, departure: departureMs(),
    destinations: idxs.map((i) => [SITES[i].lat, SITES[i].lng]),
  }).then((d) => {
    const map_ = {};
    d.results.forEach((r) => {
      const s = SITES[idxs[r.i]];
      if (s) map_[s.id] = { sec: r.sec, m: r.m };
    });
    gEta = map_;
    gEtaKey = key;
    gEtaAt = Date.now();
    updateEtaSource();
    renderCritical();
    renderRecommendations();
  }).catch(() => {
    gEta = null;              // el modelo local sigue funcionando
    updateEtaSource();
  }).finally(() => { gEtaFetching = false; });
}

/** Decodificador estándar de polilíneas de Google */
function decodePolyline(str) {
  const pts = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

/* ============================================================
 * 2. AVATAR (3D interactivo con respaldo 2D)
 * ============================================================ */
const AV_SKINS = ['#f6d3b3', '#eab68f', '#c68863', '#8d5a3b'];
const AV_HAIRC = ['#2b2118', '#5b3a1e', '#a86b2d', '#d9a441', '#9aa7b1'];
// prendas en la paleta de la mariposa (alas azules y verdes del logo)
const AV_SHIRTS = ['#287dbc', '#4eafcb', '#5a99cd', '#a6d11d', '#23ab75', '#77d8af'];
const AV_DEFAULT = { skin: AV_SKINS[1], style: 'corto', hair: AV_HAIRC[0], shirt: AV_SHIRTS[0], glasses: 'no' };

let avatarCfg = { ...AV_DEFAULT };
let avatarImg = null;      // snapshot PNG del modelo 3D
let use3D = false;

/** SVG 2D plano (respaldo y avatares de otros usuarios sin imagen) */
function avatarSVG(cfg) {
  cfg = { ...AV_DEFAULT, ...(cfg || {}) };
  let hair = '';
  if (cfg.style === 'corto') {
    hair = '<path d="M18 28 a14 14 0 0 1 28 0 l-3 0 a11 11 0 0 0 -22 0 z" fill="' + cfg.hair + '"/>';
  } else if (cfg.style === 'largo') {
    hair = '<path d="M18 28 a14 14 0 0 1 28 0 v16 h-6 v-12 h-16 v12 h-6 z" fill="' + cfg.hair + '"/>';
  }
  const glasses = cfg.glasses === 'si'
    ? '<g stroke="#1d2b36" fill="none" stroke-width="1.7">' +
      '<circle cx="26.5" cy="29" r="4"/><circle cx="37.5" cy="29" r="4"/><path d="M30.5 29 h3"/></g>'
    : '';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<circle cx="32" cy="32" r="32" fill="#e8f1fb"/>' +
    '<path d="M12 64 C12 46 52 46 52 64 Z" fill="' + cfg.shirt + '"/>' +
    '<circle cx="32" cy="28" r="14" fill="' + cfg.skin + '"/>' +
    hair + glasses +
    '<circle cx="27" cy="30" r="1.6" fill="#1d2b36"/>' +
    '<circle cx="37" cy="30" r="1.6" fill="#1d2b36"/>' +
    '<path d="M28 36 q4 3 8 0" stroke="#1d2b36" stroke-width="1.6" fill="none" stroke-linecap="round"/>' +
    '</svg>';
}

function avatarHtml(cfg, img) {
  return img ? '<img src="' + img + '" alt="avatar">' : avatarSVG(cfg);
}

function userIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="user-avatar-pin">' + avatarHtml(avatarCfg, avatarImg) + '</div>',
    iconSize: [46, 46],
    iconAnchor: [23, 23],
  });
}

let avatarSaveTimer = null;
function applyAvatar() {
  if (use3D) {
    Avatar3D.update(avatarCfg);
    // dar un frame al renderer antes del snapshot
    requestAnimationFrame(() => {
      avatarImg = Avatar3D.snapshot() || avatarImg;
      paintAvatar();
    });
  } else {
    avatarImg = null;
    paintAvatar();
  }
  syncAvatarControls();
  clearTimeout(avatarSaveTimer);
  avatarSaveTimer = setTimeout(() => {
    api('/api/avatar', 'POST', { cfg: avatarCfg, img: avatarImg }).catch(() => {});
  }, 500);
}

function paintAvatar() {
  $('btn-avatar').innerHTML = avatarHtml(avatarCfg, avatarImg);
  if (!use3D) $('avatar-preview-2d').innerHTML = avatarSVG(avatarCfg);
  if (userMarker) userMarker.setIcon(userIcon());
}

function buildSwatches(id, colors, key) {
  const box = $(id);
  box.innerHTML = '';
  colors.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.c = c;
    b.title = c;
    b.addEventListener('click', () => { avatarCfg[key] = c; applyAvatar(); });
    box.appendChild(b);
  });
}

function syncAvatarControls() {
  const mark = (id, key, attr) => {
    $(id).querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset[attr] === avatarCfg[key]);
    });
  };
  mark('av-skin', 'skin', 'c');
  mark('av-hair', 'hair', 'c');
  mark('av-shirt', 'shirt', 'c');
  mark('av-style', 'style', 'v');
  mark('av-glasses', 'glasses', 'v');
}

let avatarUiBuilt = false;
function initAvatar() {
  avatarCfg = { ...AV_DEFAULT, ...(currentUser.avatar || {}) };
  avatarImg = currentUser.avatarImg || null;
  if (!avatarUiBuilt) {
    avatarUiBuilt = true;
    buildSwatches('av-skin', AV_SKINS, 'skin');
    buildSwatches('av-hair', AV_HAIRC, 'hair');
    buildSwatches('av-shirt', AV_SHIRTS, 'shirt');
    ['av-style', 'av-glasses'].forEach((id) => {
      const key = id === 'av-style' ? 'style' : 'glasses';
      $(id).querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', () => { avatarCfg[key] = b.dataset.v; applyAvatar(); });
      });
    });
    $('btn-avatar').addEventListener('click', () => {
      $('avatar-modal').classList.remove('hidden');
      if (!use3D && Avatar3D.available()) {
        use3D = Avatar3D.mount($('avatar-3d'));
        $('avatar-3d').classList.toggle('hidden', !use3D);
        $('avatar-preview-2d').classList.toggle('hidden', use3D);
        $('avatar-hint').textContent = use3D
          ? 'Arrástralo para girarlo · haz clic para que salude'
          : 'Vista 2D (tu navegador no soporta WebGL).';
        if (use3D) applyAvatar();
      }
    });
    $('avatar-wave').addEventListener('click', () => Avatar3D.wave());
    $('avatar-done').addEventListener('click', () => $('avatar-modal').classList.add('hidden'));
    $('avatar-modal').addEventListener('click', (e) => {
      if (e.target === $('avatar-modal')) $('avatar-modal').classList.add('hidden');
    });
  }
  paintAvatar();
  syncAvatarControls();
}

/* ============================================================
 * 3. FESTIVOS + HORARIOS
 * ============================================================ */
const FESTIVOS = new Set([
  '2025-01-01','2025-01-06','2025-03-24','2025-04-17','2025-04-18','2025-05-01','2025-06-02',
  '2025-06-23','2025-06-30','2025-08-07','2025-08-18','2025-10-13','2025-11-03','2025-11-17',
  '2025-12-08','2025-12-25',
  '2026-01-01','2026-01-12','2026-03-23','2026-04-02','2026-04-03','2026-05-01','2026-05-18',
  '2026-06-08','2026-06-15','2026-06-29','2026-07-20','2026-08-07','2026-08-17','2026-10-12',
  '2026-11-02','2026-11-16','2026-12-08','2026-12-25',
  '2027-01-01','2027-01-11','2027-03-22','2027-03-25','2027-03-26','2027-05-01','2027-05-10',
  '2027-05-31','2027-06-07','2027-07-05','2027-07-20','2027-08-16','2027-10-18','2027-11-01',
  '2027-11-15','2027-12-08','2027-12-25',
]);

function isFestivo(date) {
  const k = date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
  return FESTIVOS.has(k);
}

function dayKeyFor(date) {
  if (isFestivo(date)) return 'H';
  return String((date.getDay() + 6) % 7);
}

function rangeFor(site, date) {
  const sched = site.schedule || {};
  let v = sched[dayKeyFor(date)];
  if (v === undefined && dayKeyFor(date) === 'H') v = sched['6'];
  return v === undefined ? null : v;
}

function siteStatus(site, date) {
  const mins = date.getHours() * 60 + date.getMinutes();
  const v = rangeFor(site, date);
  if (v === '24h') return { open: true, is24h: true, closesInMin: Infinity };
  if (Array.isArray(v) && mins >= v[0] && mins < v[1]) {
    return { open: true, is24h: false, closesInMin: v[1] - mins, closeMin: v[1] };
  }
  if (Array.isArray(v) && mins < v[0]) {
    return { open: false, opensToday: true, opensAtMin: v[0], opensInMin: v[0] - mins };
  }
  for (let i = 1; i <= 7; i++) {
    const d = new Date(date.getTime() + i * 86400000);
    const nv = rangeFor(site, d);
    if (nv === '24h') return { open: false, opensNext: { days: i, min: 0 } };
    if (Array.isArray(nv)) return { open: false, opensNext: { days: i, min: nv[0] } };
  }
  return { open: false };
}

function fmtHora(min) {
  let h = Math.floor(min / 60), m = min % 60;
  const ap = h >= 12 ? 'p.m.' : 'a.m.';
  h = h % 12 || 12;
  return h + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

const DIA_NOMBRE = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/* ============================================================
 * 4. MODELO DE TRÁFICO DE BOGOTÁ
 * ============================================================ */
const VEL_CARRO_KMH = 26;
const VEL_PIE_KMH = 4.7;
const FACTOR_RUTA = 1.35;

function trafficFactor(date) {
  const h = date.getHours() + date.getMinutes() / 60;
  const festivo = isFestivo(date);
  const dow = date.getDay();
  if (festivo || dow === 0) return (h >= 10 && h < 19) ? 0.85 : 1.0;
  if (dow === 6) {
    if (h >= 10 && h < 14) return 0.65;
    if (h >= 14 && h < 19) return 0.75;
    return 0.9;
  }
  if (h >= 6 && h < 9) return 0.45;
  if (h >= 9 && h < 11.5) return 0.75;
  if (h >= 11.5 && h < 14) return 0.65;
  if (h >= 14 && h < 16.5) return 0.75;
  if (h >= 16.5 && h < 20) return 0.40;
  if (h >= 20 && h < 22) return 0.80;
  return 1.0;
}

function trafficLabel(f) {
  if (f <= 0.5) return { txt: 'Tráfico alto · hora pico', cls: 'traffic-alto', nivel: 'alto' };
  if (f <= 0.78) return { txt: 'Tráfico moderado', cls: 'traffic-medio', nivel: 'medio' };
  return { txt: 'Tráfico fluido', cls: 'traffic-bajo', nivel: 'bajo' };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function etaMin(distKm, modo, date) {
  const ruta = distKm * FACTOR_RUTA;
  if (modo === 'caminando') return (ruta / VEL_PIE_KMH) * 60;
  return (ruta / (VEL_CARRO_KMH * trafficFactor(date))) * 60;
}

/* ============================================================
 * 4b. ANIMACIÓN DE VIAJE SOBRE LA RUTA (carro / avatar a pie)
 * ============================================================ */
const SVG_CARRO_TOP =
  '<svg viewBox="0 0 24 40" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0.8" y="6" width="3" height="7" rx="1.5" fill="#22303c"/>' +
  '<rect x="20.2" y="6" width="3" height="7" rx="1.5" fill="#22303c"/>' +
  '<rect x="0.8" y="26" width="3" height="7" rx="1.5" fill="#22303c"/>' +
  '<rect x="20.2" y="26" width="3" height="7" rx="1.5" fill="#22303c"/>' +
  '<rect x="3" y="1.5" width="18" height="37" rx="7.5" fill="#005EB8"/>' +
  '<rect x="5.5" y="8" width="13" height="8" rx="2.5" fill="#BFDCF7"/>' +
  '<rect x="5.5" y="25" width="13" height="6.5" rx="2.5" fill="#BFDCF7"/>' +
  '<rect x="5" y="16.5" width="14" height="7.5" rx="2.5" fill="#0A6BC8"/>' +
  '<rect x="6" y="1.8" width="3.4" height="2.2" rx="1" fill="#FEF3DF"/>' +
  '<rect x="14.6" y="1.8" width="3.4" height="2.2" rx="1" fill="#FEF3DF"/>' +
  '</svg>';

let travelMarker = null, travelRAF = null;
const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function travelIcon(walking) {
  const html = walking
    ? '<div class="walker-pin">' + avatarHtml(avatarCfg, avatarImg) + '</div>'
    : '<div class="car-pin"><div class="travel-rot">' + SVG_CARRO_TOP + '</div></div>';
  return L.divIcon({ className: '', html, iconSize: [36, 36], iconAnchor: [18, 18] });
}

function stopTravel() {
  if (travelRAF) cancelAnimationFrame(travelRAF);
  travelRAF = null;
  if (travelMarker) { travelMarker.remove(); travelMarker = null; }
}

/** Anima un carro (o el avatar caminando) desde el origen hasta el destino */
function startTravel(pts) {
  stopTravel();
  if (REDUCED_MOTION || !pts || pts.length < 2) return;
  // distancias acumuladas por tramo
  const cum = [0];
  let tot = 0;
  for (let i = 1; i < pts.length; i++) {
    tot += haversineKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    cum.push(tot);
  }
  if (tot <= 0) return;
  const walking = state.modo === 'caminando';
  const dur = Math.min(9000, Math.max(3800, tot * (walking ? 2200 : 900)));
  travelMarker = L.marker(pts[0], { icon: travelIcon(walking), interactive: false, zIndexOffset: 1500 }).addTo(map);
  const t0 = performance.now();
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

  function frame(now) {
    const p = (now - t0) / dur;
    if (p >= 1) {
      travelMarker.setLatLng(pts[pts.length - 1]);
      const el = travelMarker.getElement();
      if (el && el.firstChild) el.firstChild.classList.add('travel-arrived');
      travelRAF = null;
      return;
    }
    const dTarget = ease(p) * tot;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dTarget) i++;
    const f = (dTarget - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1e-9);
    travelMarker.setLatLng([
      pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
      pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f,
    ]);
    const el = travelMarker.getElement();
    if (el) {
      if (!walking) {
        // orientar el carro hacia donde avanza (0° = norte, horario)
        const deg = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]) * 180 / Math.PI;
        const rot = el.querySelector('.travel-rot');
        if (rot) rot.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)';
      }
    }
    travelRAF = requestAnimationFrame(frame);
  }
  travelRAF = requestAnimationFrame(frame);
}

/* ============================================================
 * 5. ESTADO + MAPA
 * ============================================================ */
const state = {
  user: null,
  tipo: 'todos',
  modo: 'carro',
  cuando: 'ahora',
  customDate: null,
  selectedId: null,
};
const SITES = DROGUERIAS.concat(PRESTADORES);

let map, userMarker = null, routeLine = null;
const markers = {};

function refDate() {
  return (state.cuando === 'otra' && state.customDate) ? new Date(state.customDate) : new Date();
}

/* Iconos de marca: cruz verde (droguerías) y mariposa (centros médicos) */
const SVG_CRUZ =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="8.5" y="3" width="7" height="18" rx="2" fill="#00A651"/>' +
  '<rect x="3" y="8.5" width="18" height="7" rx="2" fill="#00A651"/>' +
  '</svg>';
// Mariposa oficial (isotipo del logo Keralty, recortado en img/mariposa.svg)
const SVG_MARIPOSA = '<img src="img/mariposa.svg" alt="Centro médico" class="ico-mariposa">';

function siteIcon(s) {
  const esD = s.tipo === 'drogueria';
  return L.divIcon({
    className: '',
    html: '<div class="site-pin ' + (esD ? 'pin-d' : 'pin-p') + '">' +
      (esD ? SVG_CRUZ : SVG_MARIPOSA) + '</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function initApp() {
  if (map) { setTimeout(() => map.invalidateSize(), 60); return; }
  map = L.map('map').setView([4.657, -74.093], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  SITES.forEach((s) => {
    const m = L.marker([s.lat, s.lng], { icon: siteIcon(s) }).addTo(map);
    m.bindPopup(() => popupHtml(s), { minWidth: 260, maxWidth: 300 });
    m.on('click', () => selectSite(s.id, false));
    markers[s.id] = m;
  });

  // Cadena de carga de la foto (delegado en captura: sobrevive a re-renders del popup):
  // falla la local -> intentar Google (/api/photo, data-next); falla esa -> queda el placeholder.
  document.addEventListener('error', (ev) => {
    const img = ev.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('pop-photo-img')) return;
    const next = img.dataset.next;
    if (next) { delete img.dataset.next; img.src = next; }
    else img.remove();
  }, true);
  // la imagen queda oculta hasta cargar: nunca se ve el icono de imagen rota
  document.addEventListener('load', (ev) => {
    const img = ev.target;
    if (img instanceof HTMLImageElement && img.classList.contains('pop-photo-img')) {
      img.classList.add('vista');
    }
  }, true);

  legendControl();
  setInterval(refresh, 60000);
  refresh();
  if (locConsent) tryGeolocate(true);
  else showConsentModal();
}

function legendControl() {
  const ctl = L.control({ position: 'bottomright' });
  ctl.onAdd = () => {
    const div = L.DomUtil.create('div');
    div.style.cssText = 'background:#fff;padding:8px 12px;border-radius:10px;box-shadow:0 2px 8px rgba(11,45,77,.22);font:12px Figtree,sans-serif;line-height:1.7;display:flex;gap:14px;align-items:center';
    div.innerHTML =
      '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:16px;height:16px;display:inline-block">' + SVG_CRUZ + '</span> Droguería</span>' +
      '<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:16px;height:16px;display:inline-block">' + SVG_MARIPOSA + '</span> Centro médico</span>';
    return div;
  };
  ctl.addTo(map);
}

/* ============================================================
 * 6. PUNTOS DE RECOMENDACIÓN (0–100 por tiempos y horario)
 * ============================================================ */
function sitePoints(r) {
  let pts = 100 - Math.min(60, r.eta) * 1.05;   // penaliza el tiempo de viaje
  if (!r.st.open) pts -= r.st.opensToday ? 35 : 55;
  if (r.critical === 'no-alcanza') pts -= 30;
  else if (r.critical === 'critico') pts -= 12;
  if (r.st.is24h) pts += 8;                      // bono disponibilidad total
  return Math.max(1, Math.min(100, Math.round(pts)));
}

function ptsChip(pts, extraClass) {
  const cls = pts >= 75 ? 'pts-alto' : pts >= 45 ? 'pts-medio' : 'pts-bajo';
  return '<span class="pts ' + cls + ' ' + (extraClass || '') + '" ' +
    'title="Puntos de recomendación: combinan tiempo de viaje con tráfico, distancia y horario de atención">' +
    pts + ' pts</span>';
}

function evalSite(s, d) {
  const km = haversineKm(state.user.lat, state.user.lng, s.lat, s.lng);
  let eta, distKm, fuente;
  const g = gEta && gEta[s.id];
  if (g) {                                   // tiempo real de Google (con tráfico)
    eta = g.sec / 60;
    distKm = g.m / 1000;
    fuente = 'google';
  } else {                                   // modelo heurístico local
    eta = etaMin(km, state.modo, d);
    distKm = km * FACTOR_RUTA;
    fuente = 'local';
  }
  const st = siteStatus(s, d);
  const arrivalMin = d.getHours() * 60 + d.getMinutes() + eta;
  let critical = null;
  if (st.open && !st.is24h) {
    const margen = st.closeMin - arrivalMin;
    if (margen <= 0) critical = 'no-alcanza';
    else if (margen <= 30) critical = 'critico';
  }
  const r = { s, km, distKm, eta, st, critical, arrivalMin, fuente };
  r.pts = sitePoints(r);
  return r;
}

function popupHtml(s) {
  const d = refDate();
  const st = siteStatus(s, d);
  let estado;
  if (st.is24h) estado = '<b style="color:#6a4bc4">Abierto 24 horas</b>';
  else if (st.open) estado = '<b style="color:#2e9e5b">Abierto</b> · cierra a las ' + fmtHora(st.closeMin);
  else if (st.opensToday) estado = '<b style="color:#d64545">Cerrado</b> · abre hoy a las ' + fmtHora(st.opensAtMin);
  else estado = '<b style="color:#d64545">Cerrado</b>';

  let extra;
  if (s.tipo === 'drogueria') {
    extra = '<div class="pop-line">' + escapeHtml(s.tipologia + ' · ' + (s.canal || '')) + '</div>';
  } else {
    extra = '<div class="pop-line">' + escapeHtml(s.categoria) + '</div>';
  }
  let eta = '', pts = '';
  if (state.user) {
    const r = evalSite(s, d);
    eta = '<div class="pop-line">' + r.distKm.toFixed(1) + ' km · ~' +
      Math.round(r.eta) + ' min (' + (state.modo === 'carro' ? 'carro' : 'a pie') +
      (r.fuente === 'google' ? ' · Google' : '') + ')</div>';
    pts = ' ' + ptsChip(r.pts);
  }
  // foto del lugar: local (img/sitios/<id>.jpg) -> Google Places -> placeholder
  const fotoQ = encodeURIComponent(s.nombre + ', ' + s.direccion.split('\n')[0] + ', Bogotá, Colombia');
  const foto = '<div class="pop-photo">' +
    '<div class="pop-photo-ph">' + (s.tipo === 'drogueria' ? SVG_CRUZ : SVG_MARIPOSA) +
    '<span class="pop-photo-txt">Foto del local no disponible aún</span></div>' +
    '<img class="pop-photo-img" alt="" src="img/sitios/' + s.id + '.jpg" ' +
    'data-next="/api/photo?key=' + s.id + '&q=' + fotoQ + '">' +
    '</div>';

  return foto +
    '<div class="pop-title">' + escapeHtml(s.nombre) + pts + '</div>' +
    extra +
    '<div class="pop-line">' + escapeHtml(s.direccion) + '</div>' +
    '<div class="pop-line">' + estado + '</div>' + eta +
    '<div class="pop-horario">' + escapeHtml(s.horarioRaw).replace(/\n/g, '<br>') + '</div>';
}

/* ============================================================
 * 7. UBICACIÓN: GPS + autocompletar
 * ============================================================ */
const BOGOTA_VIEWBOX = '-74.26,4.84,-73.98,4.42';

function setUserLocation(lat, lng, label) {
  if (!locConsent) {           // primero el permiso de uso de datos de ubicación
    pendingLocation = [lat, lng, label];
    showConsentModal();
    return;
  }
  state.user = { lat, lng, label };
  stopTravel();
  $('loc-status').textContent = label;
  $('loc-status').classList.add('ok');
  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lng], { icon: userIcon(), zIndexOffset: 1000 })
    .addTo(map).bindPopup('<b>Tu ubicación</b><br>' + escapeHtml(label));
  map.setView([lat, lng], 14);
  api('/api/location', 'POST', { lat, lng, label, accuracy: gpsAccuracy }).catch(() => {});
  refresh();
  startGeoWatch();   // con consentimiento dado, seguir el desplazamiento en vivo
}

function tryGeolocate(silent) {
  if (!navigator.geolocation) {
    if (!silent) $('loc-status').textContent = 'Tu navegador no soporta geolocalización. Escribe tu dirección.';
    return;
  }
  $('loc-status').textContent = 'Obteniendo tu ubicación…';
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      gpsAccuracy = accuracy || null;
      let label = 'Mi ubicación actual (GPS)';
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=' + lat +
          '&lon=' + lng + '&zoom=17&accept-language=es', { headers: { 'Accept': 'application/json' } });
        const j = await r.json();
        if (j.display_name) label = 'GPS: ' + j.display_name.split(',').slice(0, 3).join(',');
      } catch (e) {}
      setUserLocation(lat, lng, label);
      updateAccuracyCircle(lat, lng);
      startGeoWatch();   // seguir compartiendo la posición mientras se mueva
    },
    () => {
      $('loc-status').textContent = silent
        ? 'No pudimos usar tu GPS. Escribe tu dirección arriba y te la sugerimos.'
        : 'Permiso de ubicación denegado. Escribe tu dirección.';
      $('loc-status').classList.remove('ok');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 }
  );
}
$('btn-geo').addEventListener('click', () => tryGeolocate(false));

/* Reporte continuo de desplazamientos (solo con permiso del usuario).
 *
 * Diseño del rastreo:
 * - Filtro ADAPTATIVO: acepta la mejor lectura disponible. Con posición fresca
 *   exige <=150 m de error; si llevamos >30 s sin lectura útil acepta hasta
 *   800 m (mejor una posición aproximada que ninguna).
 * - Umbral de movimiento proporcional al error (anti-ruido), entre 8 y 60 m.
 * - Cadencia máxima: 1 envío cada 5 s. Latido cada 30 s aunque esté quieto,
 *   para que el admin vea la traza "hace segundos" y la sesión siga viva.
 * - Indicador visible del estado (en vivo / señal débil / envíos realizados).
 * - Wake lock: la pantalla no se apaga mientras se comparte (el GPS de los
 *   teléfonos se pausa con la pantalla apagada). */
let geoWatchId = null, geoLastPost = 0, geoLastPos = null;
let gpsAccuracy = null, accCircle = null;
let geoSendCount = 0, geoLastFixAt = 0, wakeLock = null;

function setLocStatus(texto, ok) {
  $('loc-status').textContent = texto;
  $('loc-status').classList.toggle('ok', !!ok);
}

function updateAccuracyCircle(lat, lng) {
  if (!gpsAccuracy || !map) return;
  if (accCircle) accCircle.setLatLng([lat, lng]).setRadius(gpsAccuracy);
  else {
    accCircle = L.circle([lat, lng], {
      radius: gpsAccuracy, color: '#005EB8', weight: 1,
      opacity: 0.45, fillOpacity: 0.08, interactive: false,
    }).addTo(map);
  }
}

function onGeoFix(pos) {
  const { latitude: lat, longitude: lng } = pos.coords;
  const acc = pos.coords.accuracy || 99;
  const now = Date.now();

  // filtro adaptativo de precisión
  const limite = (state.user && now - geoLastFixAt < 30000) ? 150 : 800;
  if (acc > limite) {
    setLocStatus('Señal GPS débil (±' + Math.round(acc) + ' m) — esperando mejor precisión…', false);
    return;
  }
  geoLastFixAt = now;
  gpsAccuracy = acc;

  // anti-ruido: solo cuenta como movimiento si supera el umbral proporcional
  const umbralM = Math.max(8, Math.min(60, acc * 0.6));
  const movedM = geoLastPos ? haversineKm(geoLastPos[0], geoLastPos[1], lat, lng) * 1000 : Infinity;
  const latido = now - geoLastPost > 30000;
  if (movedM < umbralM && !latido) return;
  if (now - geoLastPost < 5000) return;

  geoLastPost = now;
  geoLastPos = [lat, lng];
  const label = (state.user && state.user.label) || 'GPS en vivo';
  state.user = { lat, lng, label };
  if (userMarker) userMarker.setLatLng([lat, lng]);
  updateAccuracyCircle(lat, lng);
  geoSendCount++;
  setLocStatus('En vivo · ±' + Math.round(acc) + ' m · ' + geoSendCount +
    (geoSendCount === 1 ? ' envío' : ' envíos') + ' · ' + label, true);
  api('/api/location', 'POST', { lat, lng, label, accuracy: acc }).catch(() => {});
  refresh();
}

/* Presencia: los navegadores pausan el GPS en segundo plano. Al ocultarse la
 * app avisamos "pausado" (sendBeacon funciona durante la salida) y al volver
 * publicamos la posición actual de inmediato (salto de recuperación). */
function sendPresence(state) {
  try {
    const blob = new Blob([JSON.stringify({ state })], { type: 'application/json' });
    if (navigator.sendBeacon && navigator.sendBeacon('/api/presence', blob)) return;
  } catch (e) { /* caer al fetch */ }
  api('/api/presence', 'POST', { state }).catch(() => {});
}

document.addEventListener('visibilitychange', () => {
  if (!currentUser || !locConsent) return;
  if (document.visibilityState === 'hidden') {
    sendPresence('pausado');
  } else {
    sendPresence('activo');
    setLocStatus('Reanudando rastreo…', false);
    geoLastPost = 0;   // el próximo fix publica sin esperar cadencia
    if (navigator.geolocation && geoWatchId != null) {
      navigator.geolocation.getCurrentPosition(onGeoFix, () => {},
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    }
  }
});

async function pedirWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* no soportado o denegado: seguimos sin él */ }
}

function startGeoWatch() {
  if (geoWatchId != null || !navigator.geolocation || !locConsent) return;
  geoWatchId = navigator.geolocation.watchPosition(onGeoFix, (err) => {
    if (err && err.code === 1) {
      setLocStatus('Permiso de GPS denegado en el navegador: activa la ubicación para compartir en vivo.', false);
    }
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 25000 });
  pedirWakeLock();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pedirWakeLock();
  });
}

let acTimer = null, acAbort = null;
const addrInput = $('addr-input'), sugBox = $('addr-suggestions');

addrInput.addEventListener('input', () => {
  const q = addrInput.value.trim();
  clearTimeout(acTimer);
  if (q.length < 4) { sugBox.classList.add('hidden'); return; }
  acTimer = setTimeout(() => fetchSuggestions(q), 420);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.autocomplete-wrap')) sugBox.classList.add('hidden');
});

async function fetchSuggestions(q) {
  if (acAbort) acAbort.abort();
  acAbort = new AbortController();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=es' +
    '&countrycodes=co&bounded=1&viewbox=' + BOGOTA_VIEWBOX +
    '&q=' + encodeURIComponent(q + ', Bogotá, Colombia');
  try {
    const r = await fetch(url, { signal: acAbort.signal, headers: { 'Accept': 'application/json' } });
    const list = await r.json();
    sugBox.innerHTML = '';
    if (!list.length) {
      sugBox.innerHTML = '<div style="cursor:default;color:#999">Sin resultados en Bogotá…</div>';
    } else {
      list.forEach((it) => {
        const div = document.createElement('div');
        div.textContent = it.display_name.split(',').slice(0, 4).join(',');
        div.addEventListener('click', () => {
          addrInput.value = div.textContent;
          sugBox.classList.add('hidden');
          setUserLocation(parseFloat(it.lat), parseFloat(it.lon), div.textContent);
        });
        sugBox.appendChild(div);
      });
    }
    sugBox.classList.remove('hidden');
  } catch (e) { /* petición cancelada o sin red */ }
}

/* ============================================================
 * 8. RECOMENDACIONES
 * ============================================================ */
function recommend() {
  if (!state.user) return [];
  const d = refDate();
  return SITES
    .filter((s) => state.tipo === 'todos' || s.tipo === state.tipo)
    .map((s) => evalSite(s, d))
    .sort((a, b) => b.pts - a.pts || a.eta - b.eta);
}

function renderRecommendations() {
  const box = $('reco-list');
  if (!state.user) {
    box.innerHTML = '<div class="empty">Indica tu ubicación para ver las mejores opciones cerca de ti.</div>';
    return;
  }
  const d = refDate();
  const recos = recommend().slice(0, 8);
  box.innerHTML = '';
  recos.forEach((r, i) => {
    const { s, st } = r;
    const card = document.createElement('div');
    card.className = 'reco-card' + (state.selectedId === s.id ? ' selected' : '') + (i === 0 ? ' top' : '');
    const distTxt = r.distKm.toFixed(1) + ' km';

    let estadoBadge;
    if (st.is24h) estadoBadge = '<span class="badge b24">24 horas</span>';
    else if (st.open && st.closesInMin <= 60) estadoBadge = '<span class="badge cierra">Cierra en ' + Math.round(st.closesInMin) + ' min</span>';
    else if (st.open) estadoBadge = '<span class="badge abierto">Abierto · hasta ' + fmtHora(st.closeMin) + '</span>';
    else if (st.opensToday) estadoBadge = '<span class="badge cerrado">Cerrado · abre ' + fmtHora(st.opensAtMin) + '</span>';
    else if (st.opensNext) {
      const nd = new Date(d.getTime() + st.opensNext.days * 86400000);
      estadoBadge = '<span class="badge cerrado">Cerrado · abre ' + DIA_NOMBRE[(nd.getDay() + 6) % 7] + ' ' + fmtHora(st.opensNext.min) + '</span>';
    } else estadoBadge = '<span class="badge cerrado">Cerrado</span>';

    const tipoBadge = s.tipo === 'drogueria'
      ? '<span class="badge tipo-d"><span class="badge-ico">' + SVG_CRUZ + '</span>Droguería · ' + escapeHtml(s.tipologia) + '</span>'
      : '<span class="badge tipo-p"><span class="badge-ico">' + SVG_MARIPOSA + '</span>' + escapeHtml(s.categoria) + '</span>';

    let extras = '';
    if (s.tipo === 'drogueria') {
      if (s.altoCosto === 'SI') extras += '<span class="badge gris">Alto costo</span>';
      if (s.refrigerados === 'SI') extras += '<span class="badge gris">Refrigerados</span>';
    }

    let warn = '';
    if (r.critical === 'no-alcanza') {
      warn = '<div class="reco-warn rojo">Con el tráfico actual NO alcanzas a llegar antes del cierre (' + fmtHora(st.closeMin) + ').</div>';
    } else if (r.critical === 'critico') {
      warn = '<div class="reco-warn ambar">Crítico: llegarías ~' + Math.max(1, Math.round(st.closeMin - r.arrivalMin)) + ' min antes del cierre. Sal ya.</div>';
    }

    card.innerHTML =
      '<div class="reco-rank">' + (i + 1) + '</div>' +
      (i === 0 ? '<div class="top-tag">Tu mejor opción ahora</div>' : '') +
      '<div class="reco-head"><div class="reco-name">' + escapeHtml(s.nombre) + '</div>' +
      '<div class="reco-right">' + ptsChip(r.pts) + '<span class="reco-eta">~' + Math.round(r.eta) + ' min</span></div></div>' +
      '<div class="reco-sub">' + escapeHtml(s.direccion) + ' · ' + distTxt + '</div>' +
      '<div class="reco-badges">' + tipoBadge + estadoBadge + extras + '</div>' + warn;

    card.addEventListener('click', () => selectSite(s.id, true));
    box.appendChild(card);
  });
}

/* Aviso transitorio sobre el mapa (p. ej. cuando la ruta real no llega) */
let avisoT = null;
function avisoMapa(txt) {
  let el = $('map-aviso');
  if (!el) {
    el = document.createElement('div');
    el.id = 'map-aviso';
    el.className = 'map-aviso';
    document.getElementById('map').appendChild(el);
  }
  el.textContent = txt;
  el.classList.add('on');
  clearTimeout(avisoT);
  avisoT = setTimeout(() => el.classList.remove('on'), 4500);
}

const routeCache = {};   // clave origen|destino|modo|hora -> respuesta de /api/route

function aplicarRuta(s, id, pan, r) {
  if (state.selectedId !== id) return;
  if (r.sec) {
    gEta = gEta || {};
    gEta[s.id] = { sec: r.sec, m: r.m };
    renderRecommendations();
    if (markers[id].isPopupOpen()) markers[id].setPopupContent(popupHtml(s));
  }
  if (!r.polyline) return;
  const pts = decodePolyline(r.polyline);
  if (pts.length < 2) return;
  if (routeLine) routeLine.remove();
  routeLine = L.polyline(pts, { color: '#0055a5', weight: 4.5, opacity: 0.85 }).addTo(map);
  if (pan) map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });
  startTravel(pts);
}

function selectSite(id, pan) {
  state.selectedId = id;
  const s = SITES.find((x) => x.id === id);
  if (!s) return;
  if (routeLine) { routeLine.remove(); routeLine = null; }
  stopTravel();
  if (state.user) {
    // línea recta punteada de inmediato; se reemplaza por la ruta real de Google
    const recta = [[state.user.lat, state.user.lng], [s.lat, s.lng]];
    routeLine = L.polyline(recta,
      { color: '#0055a5', weight: 3, dashArray: '7 7', opacity: 0.75 }
    ).addTo(map);
    if (pan) map.fitBounds(routeLine.getBounds(), { padding: [60, 60] });
    startTravel(recta);
    if (googleOn) {
      const rk = s.id + '|' + state.user.lat.toFixed(4) + ',' + state.user.lng.toFixed(4) +
        '|' + state.modo + '|' + (departureMs() || 'now');
      if (routeCache[rk]) {
        aplicarRuta(s, id, pan, routeCache[rk]);   // instantáneo: sin red ni cupo
      } else {
        // si Google tarda, avisar que estamos calculando
        const lento = setTimeout(() => avisoMapa('Calculando la ruta real…'), 800);
        api('/api/route', 'POST', {
          olat: state.user.lat, olng: state.user.lng,
          dlat: s.lat, dlng: s.lng,
          mode: state.modo, departure: departureMs(),
        }).then((r) => {
          clearTimeout(lento);
          routeCache[rk] = r;
          aplicarRuta(s, id, pan, r);
        }).catch((e) => {
          clearTimeout(lento);
          // la línea recta queda como aproximación, pero se dice claramente
          avisoMapa(e && e.message === 'presupuesto-diario-agotado'
            ? 'Ruta aproximada: se agotó el cupo diario de rutas reales'
            : 'Ruta aproximada: no se pudo obtener la ruta real');
        });
      }
    }
  } else if (pan) {
    map.setView([s.lat, s.lng], 15);
  }
  markers[id].openPopup();
  renderRecommendations();
}

/* ============================================================
 * 9. TIEMPOS CRÍTICOS + CHIP DE TRÁFICO
 * ============================================================ */
function renderCritical() {
  const d = refDate();
  const f = trafficFactor(d);
  const lbl = trafficLabel(f);
  const chip = $('traffic-chip');
  chip.textContent = lbl.txt + (state.cuando === 'otra' ? ' (hora elegida)' : '');
  chip.className = 'traffic-chip ' + lbl.cls;

  const body = $('critico-body');
  const items = [];
  const dow = d.getDay();
  const h = d.getHours() + d.getMinutes() / 60;
  const laborable = dow >= 1 && dow <= 5 && !isFestivo(d);

  if (laborable) {
    if (lbl.nivel === 'alto') {
      items.push(['alto', '<b>Hora pico.</b> Estás en hora pico de Bogotá. Los tiempos en carro pueden más que duplicarse. Considera ir a pie si hay opciones a menos de 2 km.']);
    } else if (h < 16.5 && h >= 9) {
      items.push(['medio', 'El pico de la tarde empieza a las 4:30 p.m. y va hasta las 8:00 p.m. Si puedes, desplázate antes de las 4:00 p.m.']);
    } else if (h < 6) {
      items.push(['info', 'Vía libre: el pico de la mañana empieza a las 6:00 a.m.']);
    }
  } else {
    items.push(['info', (isFestivo(d) ? 'Día festivo' : 'Fin de semana') + ': tráfico más suave, pero muchos puntos tienen horario reducido o están cerrados.']);
  }

  if (state.user) {
    const recos = recommend();
    const abiertos = recos.filter((r) => r.st.open);
    const criticos = recos.filter((r) => r.critical === 'critico').slice(0, 3);
    const noAlcanza = recos.filter((r) => r.critical === 'no-alcanza').length;

    if (criticos.length) {
      criticos.forEach((r) => {
        const salida = Math.round(r.st.closeMin - r.eta - (d.getHours() * 60 + d.getMinutes()));
        items.push(['alto', '<b>' + escapeHtml(r.s.nombre) + '</b> cierra a las ' + fmtHora(r.st.closeMin) +
          ' — hora límite de salida: <b>' + (salida <= 0 ? '¡ya!' : 'en ' + salida + ' min') + '</b>']);
      });
    }
    if (noAlcanza > 0) {
      items.push(['medio', noAlcanza + ' punto(s) cercano(s) ya no son alcanzables antes de su cierre con el tráfico del momento.']);
    }
    const h24 = recos.filter((r) => r.st.is24h).slice(0, 1);
    if (abiertos.length === 0 && h24.length === 0) {
      items.push(['alto', 'Nada abierto en este momento cerca de ti según los horarios registrados.']);
    } else if (h24.length && lbl.nivel !== 'bajo') {
      items.push(['info', 'Opción segura 24 h más cercana: <b>' + escapeHtml(h24[0].s.nombre) + '</b> (~' + Math.round(h24[0].eta) + ' min).']);
    }
  } else {
    items.push(['info', 'Define tu ubicación para calcular horas límite de salida punto por punto.']);
  }

  if (!items.length) {
    items.push(['info', 'Sin alertas para este momento: hay margen de tiempo frente a los horarios de cierre.']);
  }
  body.innerHTML = items.map(([cls, html]) => '<div class="critico-item ' + cls + '">' + html + '</div>').join('');
}

/* ============================================================
 * 10. VISTA ADMINISTRADOR: usuarios en tiempo real (SSE)
 * ============================================================ */
const adminUsers = {};    // email -> user
const adminMarkers = {};  // email -> L.marker
const adminTrails = {};   // email -> {pts: [], line: L.polyline} rastro de desplazamiento
let sse = null;

let adminTick = null;
function initAdmin() {
  $('panel-admin').classList.remove('hidden');
  if (!adminTick) adminTick = setInterval(renderAdminList, 15000);
  api('/api/users').then((d) => {
    d.users.forEach(adminApplyUser);
    renderAdminList();
  }).catch(() => {});
  connectSSE();
}

function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.onopen = () => { $('admin-live').className = 'live-dot on'; };
  sse.onerror = () => {
    $('admin-live').className = 'live-dot off';
    // EventSource reintenta solo; si quedó cerrado, reintentar en 5 s
    if (sse.readyState === EventSource.CLOSED) setTimeout(connectSSE, 5000);
  };
  sse.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'user-update') {
        adminApplyUser(msg.user);
        renderAdminList();
      }
    } catch (e) {}
  };
}

function adminApplyUser(u) {
  adminUsers[u.email] = u;
  if (u.email === currentUser.email) return; // mi propio marcador ya existe
  if (u.lat == null || u.lng == null) {
    // el usuario cerró sesión (o nunca se ubicó): quitar marcador y rastro
    if (adminMarkers[u.email]) { adminMarkers[u.email].remove(); delete adminMarkers[u.email]; }
    const tr = adminTrails[u.email];
    if (tr) { if (tr.line) tr.line.remove(); delete adminTrails[u.email]; }
    return;
  }
  if (u.lat != null && u.lng != null) {
    // rastro de desplazamiento: línea teal con las últimas 40 posiciones
    const tr = adminTrails[u.email] || (adminTrails[u.email] = { pts: [], line: null });
    const last = tr.pts[tr.pts.length - 1];
    const saltoM = last ? haversineKm(last[0], last[1], u.lat, u.lng) * 1000 : Infinity;
    if (saltoM > 5) {   // ignorar vibración del GPS, guardar movimiento real
      tr.pts.push([u.lat, u.lng]);
      if (tr.pts.length > 80) tr.pts.shift();
      if (tr.pts.length > 1) {
        if (tr.line) tr.line.setLatLngs(tr.pts);
        else {
          tr.line = L.polyline(tr.pts, {
            color: '#00B2A9', weight: 3, opacity: 0.65, dashArray: '2 7', interactive: false,
          }).addTo(map);
        }
      }
    }
    const html = '<div class="peer-avatar-pin' + (u.role === 'admin' ? ' peer-admin' : '') +
      (u.presence === 'pausado' ? ' peer-pausado' : '') + '">' +
      avatarHtml(u.avatar, u.avatarImg) + '</div>';
    const icon = L.divIcon({ className: '', html, iconSize: [38, 38], iconAnchor: [19, 19] });
    if (adminMarkers[u.email]) {
      adminMarkers[u.email].setLatLng([u.lat, u.lng]).setIcon(icon);
    } else {
      adminMarkers[u.email] = L.marker([u.lat, u.lng], { icon, zIndexOffset: 800 })
        .addTo(map)
        .bindTooltip('', { direction: 'top', offset: [0, -20] });
    }
    adminMarkers[u.email].setTooltipContent(escapeHtml(u.name) + ' · ' + escapeHtml(u.label || ''));
    adminMarkers[u.email].bindPopup(
      '<div class="pop-title">' + escapeHtml(u.name) + '</div>' +
      '<div class="pop-line">' + escapeHtml(u.email) + ' · rol: ' + escapeHtml(u.role) + '</div>' +
      '<div class="pop-line">' + escapeHtml(u.label || 'sin dirección') +
        (u.accuracy ? ' · ±' + Math.round(u.accuracy) + ' m' : '') + '</div>' +
      '<div class="pop-line"><span class="est-chip ' + estadoUsuario(u).cls + '">' +
        escapeHtml(estadoUsuario(u).txt) + '</span></div>');
  }
}

/** Estado real de un usuario para la vista del admin */
function estadoUsuario(u) {
  if (u.lat == null) {
    return { txt: u.presence === 'desconectado' ? 'Cerró sesión' : 'Sin ubicación reportada', cls: 'est-off' };
  }
  if (u.presence === 'pausado') return { txt: 'Pausado · app en segundo plano', cls: 'est-pausa' };
  const s = Date.now() / 1000 - (u.updatedAt || 0);
  if (s < 45) return { txt: 'En vivo · ' + (u.accuracy ? '±' + Math.round(u.accuracy) + ' m' : 'ubicado'), cls: 'est-vivo' };
  if (s < 300) return { txt: 'Última señal ' + timeAgo(u.updatedAt), cls: 'est-idle' };
  return { txt: 'Inactivo · ' + timeAgo(u.updatedAt), cls: 'est-off' };
}

function timeAgo(ts) {
  if (!ts) return 'sin actividad';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return 'hace segundos';
  if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
  return 'hace ' + Math.round(s / 86400) + ' días';
}

function renderAdminList() {
  const list = Object.values(adminUsers)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const box = $('admin-users');
  $('admin-count').textContent = list.length;
  box.innerHTML = list.map((u) => {
    const located = u.lat != null;
    return '<div class="admin-user' + (located ? ' locatable' : '') + '" data-email="' + escapeHtml(u.email) + '">' +
      '<div class="admin-user-avatar">' + avatarHtml(u.avatar, u.avatarImg) + '</div>' +
      '<div class="admin-user-info">' +
        '<div class="admin-user-name">' + escapeHtml(u.name) +
          (u.role === 'admin' ? ' <span class="badge tipo-p">admin</span>' : '') +
          (u.email === currentUser.email ? ' <span class="badge gris">tú</span>' : '') + '</div>' +
        '<div class="admin-user-sub">' + (located ? escapeHtml(u.label || (u.lat.toFixed(4) + ', ' + u.lng.toFixed(4))) : '') + '</div>' +
        '<div class="admin-user-sub"><span class="est-chip ' + estadoUsuario(u).cls + '">' + escapeHtml(estadoUsuario(u).txt) + '</span></div>' +
      '</div></div>';
  }).join('') || '<div class="empty">Aún no hay usuarios registrados.</div>';

  box.querySelectorAll('.admin-user.locatable').forEach((el) => {
    el.addEventListener('click', () => {
      const u = adminUsers[el.dataset.email];
      if (!u || u.lat == null) return;
      map.setView([u.lat, u.lng], 15);
      const mk = adminMarkers[u.email] || (u.email === currentUser.email ? userMarker : null);
      if (mk) mk.openPopup();
    });
  });
}

/* ============================================================
 * 11. CONTROLES + REFRESH + BOOT
 * ============================================================ */
function bindSeg(id, key, cb) {
  $(id).querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      $(id).querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state[key] = b.dataset.v;
      if (cb) cb(b.dataset.v);
      refresh();
    });
  });
}
bindSeg('seg-tipo', 'tipo');
bindSeg('seg-modo', 'modo', () => {
  // al cambiar carro <-> a pie, recalcular la ruta y la animación del punto elegido
  if (state.selectedId) selectSite(state.selectedId, false);
});
bindSeg('seg-cuando', 'cuando', (v) => {
  $('dt-custom').classList.toggle('hidden', v !== 'otra');
  if (v === 'otra' && !$('dt-custom').value) {
    const n = new Date(Date.now() + 3600000);
    n.setMinutes(0, 0, 0);
    const pad = (x) => String(x).padStart(2, '0');
    $('dt-custom').value = n.getFullYear() + '-' + pad(n.getMonth() + 1) + '-' + pad(n.getDate()) +
      'T' + pad(n.getHours()) + ':' + pad(n.getMinutes());
    state.customDate = $('dt-custom').value;
  }
});
$('dt-custom').addEventListener('change', () => { state.customDate = $('dt-custom').value; refresh(); });

function refresh() {
  if (!map) return;
  maybeFetchMatrix();       // pide tiempos reales a Google si aplica (con caché)
  renderCritical();
  renderRecommendations();
  const d = refDate();
  SITES.forEach((s) => {
    const st = siteStatus(s, d);
    const el = markers[s.id].getElement();
    if (el && el.firstChild) el.firstChild.classList.toggle('pin-closed', !st.open);
  });
}

(async function boot() {
  try {
    const d = await api('/api/me');
    enterApp(d.user);
  } catch (e) { /* sin sesión: se queda en el login */ }
})();
