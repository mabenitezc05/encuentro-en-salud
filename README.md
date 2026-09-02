# Encuentro en Salud — Bogotá

Aplicación web con login por roles que ubica al usuario en el mapa de Bogotá (GPS o
dirección con autocompletar) y recomienda **droguerías** (57 puntos) y **centros
médicos** (35 puntos) con **puntos de recomendación (0–100)** calculados por tiempo
de viaje con tráfico, distancia y horario. Un **rol administrador** ve la ubicación
de todos los usuarios registrados **en tiempo real**. Cada usuario se representa con
un **avatar 3D interactivo** personalizable.

## Despliegue en Render

El repo incluye [render.yaml](render.yaml) (Blueprint). Pasos:

1. Sube el repo a GitHub (los secretos están fuera del repo vía `.gitignore`).
2. En [dashboard.render.com](https://dashboard.render.com): **New → Blueprint**,
   conecta el repo y despliega.
3. En el servicio, define las variables secretas: `ADMIN_PASS` y
   `GOOGLE_MAPS_API_KEY`. Las demás (`HOST=0.0.0.0`, `COOKIE_SECURE=1`,
   `TRUST_PROXY=1`, `GOOGLE_MODE=seleccion`) ya vienen en el Blueprint.
4. La URL pública queda con HTTPS, requisito del GPS en navegadores.

**Persistencia:** en el plan gratuito el disco es efímero — usuarios y caché de
fotos se pierden en cada despliegue/reinicio. Para conservarlos, agrega un disco
(plan pago), monta `/var/data` y define `DATA_DIR=/var/data` (líneas comentadas
en `render.yaml`).

## Permisos de uso de datos y ubicación (Ley 1581 de 2012)

- **Registro**: exige aceptar la política de tratamiento de datos (casilla
  obligatoria; el servidor rechaza el registro sin `consent:true` y guarda la
  fecha de aceptación).
- **Ubicación**: antes de usar GPS o publicar una dirección, la app muestra un
  aviso que explica qué se recolecta, quién lo ve y cómo dejar de compartir; el
  servidor **rechaza (`403`) cualquier reporte de ubicación de un usuario que no
  haya dado ese consentimiento** (fecha guardada en `loc_consent_at`).
- El GPS continuo solo se activa tras ese consentimiento.

## GPS de alta precisión (tiempo real)

- `enableHighAccuracy`, lecturas con error > 60 m se descartan.
- Umbral de movimiento dinámico: se publica al desplazarse más de
  máx(10 m, error/2), como mínimo cada 8 s.
- La precisión (±m) se reporta al servidor, se dibuja como círculo alrededor del
  usuario y el administrador la ve en el popup de cada usuario.

## Cómo ejecutarla

```bash
python3 server.py
```

Luego abrir <http://localhost:8791>. (Opcional: `PORT=xxxx` para otro puerto.)

### Cuentas

- **Admin:** `admin@colsanitas.com`. La contraseña se toma de la variable de entorno
  `ADMIN_PASS` al arrancar, o se genera aleatoria y se imprime **una sola vez** en la
  consola al crear la base de datos. Si `ADMIN_PASS` está definida en un arranque
  posterior, la contraseña del admin se restablece a ese valor:

  ```bash
  ADMIN_PASS='TuClaveSegura' python3 server.py
  ```

- **Demo (solo desarrollo):** `demo@colsanitas.com` / `demo123`.
- Cualquiera puede registrarse desde la pantalla de login (rol `user`, contraseña
  mínima de 8 caracteres). El rol **nunca** lo decide el cliente.

## Funcionalidades

| Función | Detalle |
|---|---|
| Login / registro con roles | Backend propio (`server.py`), sesiones con cookie HttpOnly. Roles `user` y `admin` validados en servidor. |
| Rol administrador | Panel "Usuarios registrados" con lista y avatares; los usuarios ubicados aparecen como marcadores en el mapa y **se mueven en vivo** (Server-Sent Events `/api/stream`, solo admin). Clic en un usuario centra el mapa en él. |
| Avatar 3D interactivo | Modelo 3D (Three.js): se arrastra para girarlo, hace un gesto de saludo 👋 al hacer clic, se balancea y rota solo. Personalizable (piel, cabello, color, camiseta, gafas). Un *snapshot* PNG del modelo es el marcador en el mapa y la miniatura que ve el admin. Respaldo 2D (SVG) si no hay WebGL. |
| Ubicación | GPS del navegador o dirección con autocompletar (Nominatim, restringido a Bogotá). Se reporta al backend (validada dentro del área de Bogotá). |
| Puntos de recomendación | Cada droguería / centro médico recibe 0–100 pts según el momento: penaliza el tiempo de viaje (con tráfico) y estar cerrado o en riesgo de cierre; bonifica 24 h. Visibles en tarjetas y popups; el ranking ordena por puntos. |
| Tiempos críticos | Chip de tráfico, "hora límite de salida" por punto, puntos ya no alcanzables, mejor opción 24 h. Selector "¿Cuándo vas?" simula otra fecha/hora (festivos 2025–2027 incluidos). |

## Sistema visual

Diseño basado en la identidad corporativa Colsanitas (guiado por la skill
`frontend-design` instalada en `.agents/skills/`):

- **Paleta**: azul corporativo `#005EB8` (≈ Pantone 300), tinta navy `#0B2D4D`,
  **asterisco naranja** `#F59C00` (≈ Pantone 144) reservado como firma — el logo, la
  "✱ mejor opción" del ranking y las alertas críticas —, teal Keralty `#00B2A9`
  para estados abiertos/positivos, y fondo azul-niebla `#EEF4FA`.
- **Tipografía**: Bricolage Grotesque (titulares/wordmark), Figtree (cuerpo) y
  Spline Sans Mono (ETAs, puntos, horarios). Cargadas de Google Fonts (la CSP del
  servidor las permite explícitamente).
- **Logo**: la mariposa Keralty (`app/img/mariposa.svg`) en insignia circular
  blanca — héroe del login (con flotación suave) y barra superior, junto al
  wordmark "Encuentro en salud". El naranja se conserva como color de énfasis
  (mejor opción del ranking y alertas críticas).
- **Iconografía del mapa**: las droguerías se marcan con la **cruz verde**
  (`#00A651`, SVG propio) y los centros médicos con la **mariposa oficial del
  logo Keralty** (`app/img/mariposa.svg`, isotipo recortado de `Keralty logo.svg`
  de Wikimedia Commons, dominio público; el logo completo queda en
  `app/img/keralty_full.svg` como referencia). Los puntos cerrados se ven en
  gris; los mismos iconos aparecen en insignias de tarjetas y leyenda.
- Accesibilidad: foco visible naranja, `prefers-reduced-motion` respetado,
  responsive hasta móvil.

## Seguridad implementada (desarrollo)

- Contraseñas con **PBKDF2-HMAC-SHA256** (200.000 iteraciones, sal por usuario);
  nunca se almacenan ni registran en claro. Comparación en tiempo constante.
- Sesiones con token aleatorio (`secrets`) en cookie **HttpOnly + SameSite=Strict**
  (mitiga XSS y CSRF), expiración de 12 h, logout que invalida el token.
- **Rate-limit de login**: 5 intentos fallidos por IP+correo cada 10 minutos.
- Autorización **en el servidor**: `/api/users` y `/api/stream` responden 403 a
  cualquier rol distinto de admin; el rol jamás viene del cliente.
- Validación de entradas: correo, longitud de campos, coordenadas dentro del área de
  Bogotá, tamaño máximo de cuerpo (200 KB) y del avatar (PNG data-URL < 150 KB).
- Cabeceras: **Content-Security-Policy** (solo `self` + CDNs necesarios),
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `no-store`.
- El API nunca expone hash/sal; salida HTML del cliente escapada (`escapeHtml`).
- Escucha solo en `127.0.0.1`.

**Para producción faltaría:** HTTPS (y cookie `Secure`), almacenamiento de sesiones
persistente, auditoría/logs centralizados, política de contraseñas más estricta y
consentimiento explícito de tratamiento de datos de ubicación (Ley 1581 de 2012).

## Google Maps para tiempos y rutas (opcional)

Si se configura una clave de **Google Maps Platform**, la app usa la **Routes API**
para tiempos reales con tráfico en vivo y rutas dibujadas sobre el mapa:

```bash
GOOGLE_MAPS_API_KEY='tu-clave' python3 server.py
```

- **Qué cambia con la clave activa:** los ETA y distancias de recomendaciones,
  puntos y tiempos críticos salen de `computeRouteMatrix` (1 origen × 92 destinos,
  `TRAFFIC_AWARE` en carro, incluida la hora futura del selector "¿Cuándo vas?");
  al seleccionar un punto se dibuja la **ruta real** (`computeRoutes` + polilínea).
  El indicador del panel de preferencias muestra la fuente activa.
- **Seguridad y costos:** la clave **solo vive en el servidor** (los endpoints
  `/api/routes` y `/api/route` hacen de proxy autenticado); hay caché de 2 minutos
  por origen/modo/hora para limitar llamadas. En Google Cloud restringe la clave a
  la *Routes API* únicamente.
- **Cómo obtener la clave:** en [console.cloud.google.com](https://console.cloud.google.com)
  crea un proyecto, habilita **Routes API**, crea una API key (facturación activa) y
  restríngela a esa API.
- **Fotos de los lugares:** los popups muestran una foto real del sitio con esta
  prioridad: (1) foto local en `app/img/sitios/<ID>.jpg` (ver `LEEME.txt` y
  `listado.csv` en esa carpeta con los 92 IDs, nombres y direcciones); (2) foto
  de **Google Places** si hay clave (*Find Place* + *Place Photo*, requiere la
  API "Places API" habilitada) — el servidor hace de proxy autenticado
  (`/api/photo`) y **cachea cada foto en disco** (`.photo_cache/`), así cada
  lugar se consulta a Google una sola vez, con caché negativa para los sitios
  sin foto; (3) placeholder de marca con el icono del lugar (cruz / mariposa).
- **Sin clave** todo sigue funcionando con el modelo heurístico local (fallback
  automático, también ante errores o cuotas agotadas de Google).

## Modelo de tráfico (heurístico)

Factores típicos de Bogotá sobre 26 km/h en carro (4,7 km/h a pie) y factor de ruta
1,35 sobre la línea recta: pico a.m. 6:00–9:00 (×0,45), pico p.m. 16:30–20:00
(×0,40), franjas intermedias ×0,65–0,80, noche ×1,0; sábados, domingos y festivos
más suaves. Ajustables en `trafficFactor` de [app/js/app.js](app/js/app.js).

## Datos

`tools/build_data.py` lee los dos Excel, parsea los horarios en texto libre a rangos
por día (incluye "24 horas", "cerrado" y festivos) y genera `app/data/data.js`:

```bash
python3 tools/build_data.py
```

## Estructura

```
├── server.py                       # backend: auth, roles, SSE tiempo real, seguridad
├── encuentro.db                    # SQLite (se crea al primer arranque)
├── Droguerias_con_coordenadas.xlsx # fuente
├── Prestadores.xlsx                # fuente
├── tools/build_data.py             # Excel -> app/data/data.js
└── app/
    ├── index.html
    ├── css/styles.css
    ├── js/app.js                   # mapa, recomendación, admin en vivo
    ├── js/avatar3d.js              # avatar 3D (Three.js)
    └── data/data.js                # 92 puntos generados
```

## Limitaciones conocidas

- ETA por distancia haversine × factor vial (sin rutas reales); integrable con OSRM
  o Google Directions.
- El autocompletar y la geocodificación inversa usan el servicio público de
  Nominatim (requiere internet; la app hace *debounce*).
- La "ubicación en tiempo real" se actualiza cuando el usuario fija o cambia su
  ubicación en la app (no hay rastreo continuo en segundo plano, a propósito).
