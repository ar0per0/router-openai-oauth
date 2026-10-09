# Resultado de implementación — 2026-10-05

> Registro histórico: las pruebas y conductas de las secciones iniciales pertenecen
> a esa revisión; no describen la validación actual. El ajuste del 2026-10-06 al
> final sustituye el contrato de autenticación de cuotas y las instrucciones de uso.

## Resultado
Implementación completada y verificada localmente; NO desplegada. Se inspeccionó y continuó el código existente. No se leyeron `.env`, credenciales ni archivos de autenticación; no se publicaron skills.

- Docker OAuth: parche estricto/idempotente para npm `openai-oauth@2.0.0`; preserva imágenes data:base64 y `CODEX_VERSION=latest`. `/oauth/rate-limits` usa el mismo `auth.getSession()` del proxy y GET `https://chatgpt.com/backend-api/wham/usage`, no `/codex/wham`. Authorization local independiente, fail-closed; errores saneados, timeout/cancelación, cuenta coincidente y respuesta máxima 256 KiB. Múltiples IDs, porcentajes consumidos, fechas Unix segundos, duración real y null desconocido. Sin llamadas de modelo para cuotas.
- Router: agregación autenticada de todos los upstreams, incluidos circuitos abiertos; cache/dedupe en vuelo, timeout y fallos parciales. Sin clave local de cuotas no llama upstreams. Observabilidad no reserva sondas ni cambia circuitos. Proxy/failover/reset y `/health` conservados y cubiertos por regresiones.
- UI `/router/`: Refrescar manual sin polling/carga automática; estado y límites por upstream. Bearer solo en memoria, nunca URL/storage. Start/Stop controla únicamente visor fetch SSE autenticado, sin reconexión automática. Buffer 200 eventos, máximo 16 visores, backpressure desconecta clientes lentos; cierre/abort libera suscriptores. Cabeceras SSE inmediatas incluso sin eventos; cierre del router destruye visores.
- Seguridad: assets externos, CSP HTTP restrictiva, no-store/nosniff, textContent; rechazo cross-origin. Misma allowlist/redacción para SSE y stdout: sin cuerpos, respuestas, URLs/query ni credenciales. Healthcheck conserva solo resultados finales, no logs de reintentos. Documentación española revisada.

## Comandos y resultados reales
Desde `router-openai-oauth`:
- `npm run check`: exit 0, sintaxis de todos los módulos y app web.
- `npm test`: **51/51 pasan**, dos ejecuciones finales consecutivas (0 fallos/cancelados/omitidos).
- `npm audit --omit=dev`: exit 0, **0 vulnerabilidades**.
- `env -u ROUTER_API_KEY -u RATE_LIMITS_API_KEY docker compose --env-file /dev/null config --quiet`: exit 0.

Desde `openai-oauth-docker`:
- `node --check oauth-rate-limits.mjs`, `node --check patch-openai-oauth.mjs`, `node --check healthcheck.mjs`, `sh -n entrypoint.sh`: exit 0.
- `env -u RATE_LIMITS_API_KEY node --test test/*.test.mjs`: **14/14 pasan**, dos ejecuciones finales consecutivas.
- Tarball `.inspection/verification/package.tgz`: SHA-512 coincide con metadata npm 2.0.0. Copia aislada del paquete real parcheada dos veces; idempotencia y `node --check` del chunk: exit 0.
- Integración del handler npm real: `/health`, autorización y ruta de cuotas con session manager sintético, sin cuentas reales. Prueba del parche previo solo imágenes; rechaza versión/anclas incompatibles y duplicadas sin mutaciones.
- `env -u RATE_LIMITS_API_KEY docker compose --env-file /dev/null config --quiet`: exit 0.
- `npm audit --prefix .inspection/verification/package --omit=dev`: **exit 1**, 5 vulnerabilidades bajas en cadena AI SDK, GHSA-866g-f22w-33x8; npm indica sin fix disponible. No se forzaron cambios incompatibles.

Pruebas web: DOM sintético/VM con botones, XSS, fragmentación UTF-8/CRLF SSE, límites de buffer y carreras Stop/Start. Pruebas HTTP reales en loopback contra mocks de cuotas y assets/CSP, sin cuentas. No equivalen a validación visual en navegador real.

## Pendientes reales / límites de evidencia
- `docker info --format '{{.ServerVersion}}'`: permiso denegado al conectar `/var/run/docker.sock`. No se construyeron imágenes ni se iniciaron/reiniciaron/desplegaron contenedores; Compose config NO prueba runtime.
- No prueba OAuth real, cuota real de cuenta ni disponibilidad de ChatGPT. API interna unstable; cambios incompatibles producen error/null, no cuota cero.
- Audit OAuth pendiente de resolución upstream/revisión compatible; audit no incluye imagen final ni Codex latest construido.
- Inspección visual navegador real y TLS/reverse proxy pendientes en entorno de despliegue.

## Construcción y uso posteriores (operador autorizado)
```bash
cd /home/prova/.openclaw/workspace-oauth-chatgpt/openai-oauth-docker
docker compose build --no-cache
cd /home/prova/.openclaw/workspace-oauth-chatgpt/router-openai-oauth
docker compose build --no-cache
```
Estos comandos son instrucciones, NO ejecuciones realizadas. No incluyen despliegue/reinicio. Conservar privadamente `ROUTER_API_KEY` para el proxy si se utiliza y las credenciales OAuth reales existentes. No se requiere clave interna de cuotas. Conservar los UPSTREAMS existentes. No introducir credenciales en repositorio o trazas shell.

Tras despliegue autorizado, UI: `http://HOST:10530/router/` (usar HTTPS en producción). Pulsar Refrescar sin contraseña; Start conecta logs y Stop desconecta solo visor. Panel, consumo y logs son públicos para clientes con acceso al puerto; `ROUTER_API_KEY` solo protege el proxy. `/health` conserva acceso y contrato previo.

Reverse proxy mismo origen: conservar Authorization, CSP y no-store; SSE sin buffering. Origin debe coincidir con esquema/Host vistos por Node; no confiar automáticamente en X-Forwarded-* ni habilitar CORS cross-origin. Consultar README de ambos proyectos para configuración completa.

## Ajuste posterior — panel local sin contraseña
Por petición del usuario, `/router/`, `/router/status`, cuotas y logs son públicos. Se eliminó el campo Bearer de la UI; la autenticación del proxy y RATE_LIMITS_API_KEY entre servicios se conservan. Se mantiene la comprobación de Origin. Cualquier cliente con acceso al puerto puede consultar el panel. Validación mínima: sintaxis y pruebas dirigidas de UI, SSE, panel público y proxy protegido. No desplegado.


## Ajuste posterior — 2026-10-06: cuotas sin clave interna y logs sin wrapping

**Completado localmente, sin build, deploy ni restart.** Se inspeccionaron los
archivos actuales antes de editar; no se leyeron/modificaron `.env`, secretos ni
credenciales reales. Se conservaron todos los demás valores de ambos Compose.

- `/oauth/rate-limits` no exige clave interna ni Bearer local. Conserva GET,
  `auth.getSession()` obligatorio y Authorization real del token de esa sesión
  hacia ChatGPT, junto con cuenta y contexto FedRamp; no hereda headers del cliente.
  Sin sesión devuelve 503; conserva saneamiento, no-store, límites y cancelación.
- Router quota reader llama todos los upstreams sin gate de clave ni header
  Authorization interno. Se eliminaron la configuración y recomendaciones de
  clave interna en ambos Compose/README y las expectativas obsoletas de tests.
  `ROUTER_API_KEY`, proxy, circuitos y failover no se modificaron.
- Parche npm estricto 2.0.0: anclas/versión validadas antes de escribir,
  idempotencia e imágenes preservadas. El helper se reemplaza después de validar
  también en paquetes previamente parcheados, permitiendo upgrade seguro en build.
  Dockerfile conserva `CODEX_VERSION=latest` y la aplicación del parche en build.
- CSS del `pre#logs`: `white-space: pre`, sin corte de palabras ni truncado;
  scroll horizontal/vertical interno. `box-sizing`, width/max-width y min-width
  acotan visor y main al viewport. UI JS/HTML y SSE backend permanecen intactos:
  200 eventos, saneamiento, Start/Stop, disconnect/backpressure, Origin y CSP.
- Panel router y endpoint OAuth de consumo son públicos para cualquier cliente
  con acceso a sus respectivos puertos. Restringir ambos a clientes de confianza;
  esto no elimina las credenciales OAuth reales ni la protección del proxy.

### Validación mínima de esta revisión (una ejecución por comando)
Desde la raíz del workspace:

```bash
npm run check --prefix router-openai-oauth
node --check openai-oauth-docker/oauth-rate-limits.mjs && node --check openai-oauth-docker/patch-openai-oauth.mjs && node --check openai-oauth-docker/test/oauth-rate-limits.test.mjs && node --check openai-oauth-docker/test/patch-openai-oauth.test.mjs && node --check router-openai-oauth/test/observability.test.mjs && node --check router-openai-oauth/test/web.test.mjs
node --test --test-name-pattern='quota without internal key|real local quota HTTP mocks' router-openai-oauth/test/observability.test.mjs
node --test --test-name-pattern='log CSS contract|manual SSE start' router-openai-oauth/test/web.test.mjs
node --test --test-name-pattern='endpoint sin clave|session manager único' openai-oauth-docker/test/oauth-rate-limits.test.mjs
node --test openai-oauth-docker/test/patch-openai-oauth.test.mjs
```

Resultados: sintaxis exit 0; quota mocks **2/2**, UI/CSS **2/2**, endpoint/session
**2/2**, integración npm/parche **4/4**; **10/10 pruebas dirigidas pasan**.
La integración npm prueba sin Bearer y con Bearer cliente no reenviado,
autorización real sintética, sesión ausente, upgrade del helper, imágenes,
idempotencia y rechazo de versión/anclas incompatibles o ambiguas.
No se ejecutaron suites completas, audit ni repeticiones de validación.
CSS probado como contrato estático; sin comprobación visual en navegador ni
pruebas con cuentas reales. Los resultados antiguos de arriba son históricos.

### Rebuild posterior de ambas imágenes (solo instrucciones para el usuario)

```bash
cd /home/prova/.openclaw/workspace-oauth-chatgpt/openai-oauth-docker
docker compose build --no-cache
cd /home/prova/.openclaw/workspace-oauth-chatgpt/router-openai-oauth
docker compose build --no-cache
```

No ejecutados. `--no-cache` fuerza reinstalar Codex latest y aplicar el helper
actual; npm OAuth sigue fijado en 2.0.0. Estos comandos solo construyen imágenes;
el despliegue/reinicio queda separado bajo control del operador. No configurar
clave interna de cuotas ni borrar tokens OAuth. Conservar volumen de credenciales,
configuración existente y `ROUTER_API_KEY` cuando se use.


## Ajuste UI — 2026-10-06: dos ventanas generales y UTC

Completado localmente, **no desplegado**. Solo presentación, pruebas dirigidas
y documentación; contrato backend/normalización sin cambios.

- Por cuenta conserva alias, Circuito/Cooldown/Deshabilitado/Fallos/Errores
  cliente/Probe y Error. Solo Límite general con **Límite 5h** y
  **Límite setmanal**; ejemplo exacto `Consumido: 33% · 06-10-2026 15:26`.
  Unix 1791300394 convertido mediante getters UTC, sin segundos/milisegundos.
  Una nota discreta UTC en el panel. Null/ausente/inválido no se convierte a
  cero ni epoch; cero explícito se conserva. Sin IDs/nombre/plan, créditos,
  recursión arbitraria/normalModelSlug ni sección duplicada por ID.
- Inspección de snapshot backend y GET real confirma nombres `failures`,
  `clientErrors`, `remainingMs`, `disabledUntil`, `probeInFlight`, `state`;
  el mapping existente es correcto y no requiere renombrado. Normalización
  conserva ventanas, porcentajes, Unix segundos, créditos y múltiples IDs.
- GET sin key a http://10.159.76.220:10530/router/, app.js, style.css,
  /router/status y /router/accounts/rate-limits: todos HTTP 200.
  Una sola consulta de cuotas, sin `refresh=1`. Cuatro cuentas sin error de
  lectura; snapshot con dos circuitos closed y dos open (3 fallos cada uno),
  errores cliente 0 y probe false. Es coherente: consultar cuota no cierra
  circuitos ni prueba disponibilidad de modelos. Esquema general con primary
  300 min y secondary 10080 min, resets numéricos y datos por ID conservados.
  Sin IDs, emails, alias reales ni dumps íntegros en este informe.
- La UI **en vivo sigue siendo anterior**: app.js contiene `Reset cuota`,
  no el nuevo título; HTML no incluye nota UTC. CSP restrictiva y CSS nowrap
  presentes. La revisión HTTP no es inspección visual de navegador ni prueba
  de exactitud de las cuotas contra el proveedor.

### Evidencia mínima de esta revisión

```bash
node --check src/web/app.js
TZ=Europe/Madrid node --test --test-name-pattern='HTML external|no startup|quota presentation|quota UTC|manual SSE start|log CSS contract' test/web.test.mjs
node --test --test-name-pattern='nullable schema|router APIs public|malformed nested' test/observability.test.mjs
```

Sintaxis exit 0; **6/6 UI + 3/3 backend = 9/9 pasan**. DOM/VM prueba
fecha UTC exacta aun con TZ Madrid, títulos, solo dos ventanas, ausencia de
campos eliminados, null/invalid/0 y estados/campos circuito. HTTP loopback
prueba snapshot real del servidor con circuito abierto/cerrado, panel público,
proxy protegido, Origin y observación sin mutación; SSE Start/Stop y CSS
horizontal cubiertos por pruebas existentes dirigidas. No suites completas
ni audit. No secretos/.env, Docker build/deploy/restart ni cambios de auth,
SSE, CSS, CSP o configuración. README actualizado.


## Ajuste UI — 2026-10-06: Router, disponibilidad y fechas uniformes

- Título document/h1 solo Router, descripción corta y nota discreta UTC.
  Resumen bajo título: `closed` activos verdes, `open` deshabilitados rojos,
  `half_open` recuperación amarilla separada; estados ausentes sin atribuir salud.
  Cuotas no influyen en esos contadores; expiración no cierra el circuito.
- Hallazgo fuente (`src/server.mjs`, snapshot; ruta accounts adjunta snapshot
  después de lectura): **`circuit.disabledUntil` ISO**, no `disabledUntilIso`.
  Solo `open` devuelve fecha; `closed` y `half_open` devuelven null. Backend
  usa cooldown finito, sin rama manual/Infinity. Fecha desconocida/no finita
  no se muestra ni se fabrica a partir del cooldown.
- Circuito español; cooldown/fallos/errores cliente solo positivos; sonda solo
  true. Sin Error: ninguno ni encabezado Límite general; conserva ambos títulos.
- Disponible = 100-usedPercent validado en 0..100, verde >25, amarillo >0 y
  ≤25, rojo 0; null/ausente/no finito/string/fuera de rango desconocido sin color.
- Actualizado, cuota, circuito y campos timestamp/time/disabledUntil SSE a
  dd-mm-yyyy hh:mm UTC. Quota segundos, circuit/log ms o ISO; otros números
  siguen intactos. JSON backend/precisión no cambia. Allowlist y textContent,
  evento en una línea horizontal, buffers y lifecycle SSE preservados.

### Evidencia dirigida

```bash
node --check src/web/app.js
TZ=Europe/Madrid node --test test/web.test.mjs
node --test --test-name-pattern='router APIs public|empty log viewer' test/observability.test.mjs
```

**16/16 DOM/VM + 2/2 HTTP loopback = 18 tests pasan**, sintaxis exit 0.
Pruebas incluyen colores/bordes/null, contadores closed/open/half_open, cooldown
expirado sin cierre, disabledUntil ISO/ms/ausente, UTC actualización/reset/log,
metadatos numéricos, ausencia de textos retirados, XSS, UTF8/CRLF, cap 200,
Stop/Start/stale/EOF/errores, CSS horizontal estático. HTTP prueba circuit snapshot
sin mutación, proxy protegido/Origin y SSE vacío inmediato.
No verificación visual en navegador ni medición de layout; no consultas live
(necesidad resuelta por fuente y mocks), suites completas, audit, Docker
build/deploy/restart. Sin leer secretos/.env. Backend, auth y failover sin cambios.
Se actualizaron expectativas obsoletas UI; historia previa de este informe intacta.

## Ajuste UI posterior — 2026-10-06: Madrid, duración relativa y grid

**Terminado en fuente, sin deploy.** Inspeccionados app.js, index.html, style.css,
pruebas, README y snapshot de circuitos antes de editar. Solo cambiaron esos
assets web, test/web.test.mjs, README y esta sección añadida; backend/auth/failover
sin cambios. No secretos/.env, APIs live, Docker build/deploy, suites completas
ni audit. Sin delegación.

- Eliminados ambos párrafos solicitados. Resumen `2 activos · 2 deshabilitados`,
  sin upstreams; recuperación/desconocidos separados, colores conservados.
- Cuota `Restante 69% · Se restablece en 2d 1h 5m`; 100-usedPercent válido,
  verde >25, amarillo (0,25], rojo 0. Null/inválido desconocido, nunca cero.
- Función compartida cuota/circuito: fecha menos Date.now al render; d/h/m
  positivos, minutos truncados, omite unidades cero; positivo <1m muestra `<1m`.
  Vencido muestra `pendiente de actualización`, sin negativos ni prometer que
  el reset ya ocurrió en backend. Fecha null/inválida muestra desconocido,
  sin title ni fecha inventada. Refrescar manual recalcula; cero timers o
  requests adicionales, SSE Start/Stop preservado.
- Circuito abierto `Deshabilitado · Se reanuda en 1d 5h 1m`: usa disabledUntil
  backend preferentemente y no sintetiza desde remainingMs. No Cooldown ms ni
  Fallos. Snapshot actual: disabledUntil ISO solo open; half_open/closed null.
  Activo/En recuperación claros; errores cliente positivos, sonda true y error
  de cuenta no vacío/no null conservados. Nunca `Error: ninguno`.
- Hover title cuota/circuito exacto DD-MM-YYYY HH:mm, mismo formato que
  Actualizado y timestamp/time/disabledUntil SSE: Intl.DateTimeFormat con
  timeZone Europe/Madrid explícita. UTC anterior +2 en octubre antes del cambio
  horario; +1 en invierno. IANA aplica DST, independiente del host/navegador.
  Backend conserva ISO/Unix/precisión y TZ servidor intactos.
- #accounts grid dos columnas iguales repeat(2,minmax(0,1fr)), una <=45rem;
  min-width:0 y overflow-wrap local para tarjetas. #logs horizontal intacto.
  CSP/assets externos/textContent conservados, sin inline script/style.

### Comandos ejecutados y resultados
Desde router-openai-oauth:

```bash
node --check src/web/app.js && node --check test/web.test.mjs
TZ=Etc/UTC node --test --test-name-pattern='HTML external|no startup|quota presentation|quota relative|refresh failures|available percent|summary|SSE dates|circuit disabledUntil|fixed clock|Madrid hover|shared countdown|accounts responsive|log CSS contract' test/web.test.mjs
node --check src/web/app.js && node --check test/web.test.mjs
TZ=America/New_York node --test --test-name-pattern='fixed clock|Madrid hover|SSE Madrid|manual SSE start' test/web.test.mjs
git diff --check -- src/web test/web.test.mjs README.md IMPLEMENTATION-RESULT.md
```

Sintaxis exit 0. Primera selección **15/15**, segunda **4/4**, sin fallos.
Segunda selección valida refresco del mismo panel con reloj avanzado y SSE
verano/invierno bajo host New York. Hover incluye ambos lados de transición DST;
cuota/circuito comparten formato. Pruebas de bordes null/expired/<1m/unidades,
colores, contadores, errores, SSE XSS/fragmentación/cap/Start/Stop y CSS dirigidas.
Expectativas fuente UTC obsoletas actualizadas; historia del informe intacta.

**Limitaciones:** DOM sintético/VM y CSS como contrato estático, no validación
visual ni medición real del layout/hover. Sin despliegue ni comprobación de
cuotas reales. git diff --check exit 0, pero carpeta no versionada en el Git
padre: no acredita diff de archivos untracked; evidencia principal archivos
inspeccionados y pruebas dirigidas. No se ejecutó suite completa.

## Ajuste UI y replay SSE — 2026-10-06 (revisión final)

Terminado en fuente, sin delegación ni deploy. Inspeccionados app.js, index.html,
style.css, hub SSE/ring, ruta/Origin backend y pruebas antes de editar.

### Archivos y cambios
- src/web/app.js: posición 1-based del array original (incluidos huecos inválidos),
  heading closed verde/open rojo/half_open amarillo, unknown sin salud atribuida.
  Countdown abierto en heading con hover Madrid existente; sin Activo/Activado
  separado ni Deshabilitado en body. Recuperación, errores/probe y cuotas intactos.
  Lifecycle normal sin mensajes; errores accesibles conservados y limpiados al
  Start exitoso. Dedupe por ID en Set ligado a 200 líneas, cursor Last-Event-ID,
  sin dedupe textual; Stop conserva lo mostrado, parser/UTF8 parcial local a task.
- src/web/index.html: status logs inicialmente vacío, role=status aria-live=polite.
- src/web/style.css: main max-width:none, width:100%, border-box y padding 1.5rem;
  grid dos columnas/una móvil intacto, logs con scroll horizontal interno.
  Filas vacías de estado ocultas, sin ocultar errores.
- src/observability.mjs: antes no había IDs; única metadata nueva id SSE con UUID
  de hub + secuencia BigInt (evita colisiones entre arranques). Mismo frame/ID en
  replay. Cursor exacto retenido omite hasta él; desconocido/evictado reproduce
  ring completo. Sin modificar JSON allowlist ni backpressure/heartbeat/cleanup.
- src/server.mjs: pasa únicamente header Last-Event-ID a hub.connect; ruta,
  Origin/CSP, auth y failover sin cambios funcionales.
- test/web.test.mjs y test/observability.test.mjs: expectativas actualizadas,
  pruebas nuevas posiciones/colores/countdown, replay y texto idéntico con IDs
  distintos, boundedness y cursor estable con fallback; regresiones conservadas.
- README.md: contrato actual actualizado; este informe solo añadido al final.

### Evidencia ejecutada
```bash
TZ=Etc/UTC node --test test/web.test.mjs
node --test --test-name-pattern='logs allowlist|SSE stable|router APIs public|log hub shutdown|empty log viewer' test/observability.test.mjs
node --check src/web/app.js && node --check src/observability.mjs && node --check src/server.mjs && node --check test/web.test.mjs && node --check test/observability.test.mjs
```
UI/SSE **25/25**; backend dirigido **5/5**; sintaxis exit 0. Pruebas con DOM/VM,
streams sintéticos, Sink y HTTP loopback/mocks: Origin, proxy protegido, circuitos
sin mutación, backpressure, flush headers y disconnect; ninguna API live.
Primer intento de nueva prueba heading falló solo por expectativa de newline
incorrecta en DOM sintético; corregida y reejecutada con éxito.

**Limitaciones:** no navegador real ni medición visual (ancho/scroll/grid son
contratos CSS estáticos), sin Docker/build/deploy, APIs live, .env/credenciales,
audit ni suite global. El ring sigue limitado a 200 eventos: los ya evictados
no son recuperables; no se introduce truncado adicional por cursor desconocido.
La deduplicación recuerda solo IDs de líneas retenidas, no historial ilimitado.
Cambio de IDs requiere servir fuente backend nueva para usar dedupe: servidor
antiguo sin IDs conserva logs pero no puede distinguir replay de texto idéntico.
Carpeta untracked en Git padre: git diff no acredita estos cambios; evidencia
principal son archivos fuente inspeccionados y pruebas anteriores.

### Revisión final adicional
Se preservó el presupuesto previo maxFrameBytes para el frame data original;
el ID SSE se añade después de esa validación para no descartar eventos antes
aceptados por el overhead nuevo. Test específico añadido y pasado. Selección
backend final **6/6** con patrón anterior más `SSE ID metadata`; sintaxis exit 0.
Selección UI bajo TZ=America/New_York **7/7** (posiciones, CSS/grid, countdown/
Madrid y replay). git diff --check exit 0 con limitación untracked indicada arriba.

## Ajuste UI/scroll — 2026-10-06: panel central y seguimiento del fondo

Completado localmente, sin delegación ni despliegue. Inspeccionados assets,
pruebas, README e informe antes de editar. Git padre sin commits y carpeta
untracked: no hay CSS anterior recuperable en historial; documentación previa
solo acredita main max-width:none, no un valor central histórico. Se eligió
72rem como ancho razonable, sin afirmar que sea el ancho antiguo exacto.

### Cambios entregados
- src/web/index.html y style.css: wrapper #router-panel centrado max-width:72rem
  para h1/resumen/Refrescar/Actualizado/cuentas. Logs fuera del wrapper; main
  ancho disponible con padding 1.5rem. Grid dos columnas desktop/una ≤45rem
  conservado; líneas logs sin wrapping, scroll horizontal/vertical internos.
- src/web/app.js: encabezados `(1) eduard`, posición del array sin reordenar.
  Seguimiento inicial del fondo en cada evento aceptado. Scroll a >4px del
  fondo suspende; ≤4px reactiva. Append pausado restaura posición vertical y
  horizontal; cuando sale una fila del cap 200, mide su altura retirándola
  antes del append y compensa el scroll, limitado a cero si el contenido se
  perdió. overflow-anchor:none evita doble compensación nativa. Sin timers,
  polling ni estados Conectado/Detenido. Stop/Start conserva intención y datos.
  Listener scroll estable registrado una vez (addEventListener idempotente),
  eliminado en pagehide; pageshow lo registra para restauración bfcache.
  Pagehide reinicia intención al fondo junto con limpieza previa de datos.
- test/web.test.mjs: mock scrollHeight/clientHeight/scrollTop con límites,
  scrollLeft y eventos/removal. Pruebas de wrapper vs logs, headings, seguimiento
  default, pausa, append pausado, tolerancia 4px, reanudación, Stop/Start en ambos
  modos, cap 200 con conservación de fila visible y clamp al inicio, cleanup.
- README actualizado y resultado añadido; este informe solo append.

### Comandos ejecutados y evidencia
Desde router-openai-oauth:
```bash
node --check src/web/app.js && node --check test/web.test.mjs
node --test --test-name-pattern='central Router|log scroll|ordered 1-based|accounts responsive|log CSS contract|manual SSE start|SSE Stop/Start|SSE reconnect|pagehide|pending old read|Stop before fetch|HTML external' test/web.test.mjs
```
Sintaxis exit 0; **13/13 pasan**, cero fallos. Selección conserva XSS textual,
UTF8/CRLF, cap/dedupe/cursor, abort stale y Start/Stop además del cambio UI.
No cambios backend, auth/failover, parsing SSE, Origin/CSP ni backpressure.

**Limitaciones:** DOM sintético (filas de 20px y viewport de 60px), CSS estático;
no acredita medición visual, geometría ni orden real de eventos scroll en
navegador, ni navegación bfcache real. Se necesita verificación visual posterior.
Sin suite global, audit, Docker/build/deploy, APIs live ni lectura de secretos.
Git diff no acredita archivos untracked; evidencia en fuente y pruebas arriba.

## Routing por cuota y refresh inicial — 2026-10-06

Implementado exclusivamente en router-openai-oauth, sin delegación. Leídos skill
Sequential API proxy review y referencia read-only-observability; petición
explícita prevalece sobre sus defaults de no auto-refresh y suite global.
Inspeccionados config, servidor, reader, assets, tests, README, Compose e informe
antes de editar. Inspección adicional solo de campos de normalización en
../openai-oauth-docker/oauth-rate-limits.mjs: used_percent → usedPercent,
reset_at → resetsAt, primary_window/secondary_window → primary/secondary,
aggregate codex y adicionales por ID. Ese proyecto no se modificó.

### Auditoría y decisiones
- Selección por petición: orden configurado desde índice cero, runtime failover
  default false; HTTP retryables 401/403/408/429/500-599, transporte/timeouts
  umbral general 3; resets umbral independiente 5, dedupe requestId, sin failover
  dentro de petición reset. Body máximo 32MiB, respuestas streaming, no retry
  tras headers. Startup validación real opcional con presupuesto umbral general:
  no se cambió ni ejecutó. Auth ROUTER_API_KEY solo proxy, reemplazo outbound
  ficticio conservado; panel/cuotas públicos con Origin/CSP previos intactos.
- Mínima arquitectura existente, sin dependencia: createQuotaReader compartido
  por routing y panel con caché aggregate 15s, deduplicación in-flight, timeout
  por instancia 10s, cap 256KiB, redirect manual. read.peek solo entrega caché
  vigente; no dato expirado usado como nueva evidencia. No consultas modelo
  adicionales, polling, monitor ni timers de actualización; quedan timeouts de
  I/O y heartbeat SSE existentes. Primera petición proxy puede esperar el timeout
  de lectura de cuotas; lecturas de cuentas paralelas, no timeout acumulado.
- src/server.mjs: proxy autorizado/body validado → await readQuotas() → acquire
  ordenado. GET accounts?refresh=1 usa la misma instancia y adjunta snapshot
  efectivo (incluye evidencia fresca) sin escribir circuitos ni reservar sondas.
  GET status solo snapshot, no I/O. Apertura /router sirve mismo asset que /router/.
- Fuente account-wide inequívoca: account.rateLimits.rateLimits primary y
  secondary; usedPercent exactamente número 100, reset finito/futuro válido en
  Unix segundos ×1000, no cálculo primera petición+5h ni cuota inferida de 500.
  Máximo de ambas ventanas agotadas. IDs adicionales específicos no se aplican
  indiscriminadamente a toda cuenta. primary corresponde a etiqueta UI 5h y
  secondary semanal; backend usa timestamps reales, no duraciones inventadas.
- Circuit breaker separa openUntil genérico de quotaUntil/quotaRecovery. acquire
  y succeeded sincronizan evidencia fresca, incrementando generation al aplicar
  nuevo bloqueo y descartando resultados anteriores. Cuota confirmada por
  selección/completado queda latched hasta fecha conocida aun si reader falla;
  unknown/stale/reset pasado no crea ni extiende bloqueo. Cuota refreshed >0
  no cancela bloqueo confirmado ni cierra circuito genérico: default conservador.
  Tras vencimiento aplicado: half_open y single probe, closed solo por éxito
  vigente. Fallo de sonda vuelve al fallback genérico si no hay reset válido.
  Estados y fecha efectiva compartidos en snapshot/API y gating, resumen no
  declara half_open activo. Al bloquear todos: 503 Retry-After mínimo efectivo.
- Fallback genérico interno 10m preservado (también startup y ECONNRESET), con
  override histórico UPSTREAM_COOLDOWN compatible. Eliminado del Compose ejemplo
  y tabla de configuración activa; comentario config y README distinguen fallback
  del reset de cuota. QUOTA_TIMEOUT_MS/QUOTA_CACHE_MS comentados en Compose.
- src/web/app.js: refreshAccounts compartido manual/inicial, llamada inicial
  única; errores, abort/stale-task, pagehide intactos; pageshow no refresca ni
  abre SSE. Una petición cuotas con status adjunto, no segundo GET status.
  Eliminado Se reanuda en del encabezado. Mantiene (1), colores, unknown,
  recuperación, cuotas countdown con hover Madrid. Sin cambio parser SSE,
  dedupe IDs, logs fullwidth/scroll pausa-reanudación ni Start/Stop.
- Test harness web aísla refresh inicial en tests heredados de interacción;
  test dedicado usa ejecución inicial real y cuenta requests incluso al fallar.
  Helpers de router anteriores inyectan cuota desconocida para que sus mocks de
  generación no sean confundidos con endpoint cuotas nuevo.

### Verificación dirigida (no suite global)
Comandos desde router-openai-oauth, todos los últimos resultados exitosos:

```bash
npm run check
node --check test/quota-routing.test.mjs
node --check test/web.test.mjs
node --check test/router.test.mjs
node --test test/quota-routing.test.mjs
node --test --test-name-pattern='startup refresh|no circuit header|refresh failures|pagehide|ordered 1-based|Madrid hover|shared countdown|summary trusts|fixed clock' test/web.test.mjs
node --test --test-name-pattern='permite una sola sonda|generación antigua|abre el circuito tras tres|protege las rutas|RUNTIME_FAILOVER desactivado devuelve|reenvía el mismo cuerpo|transmite respuestas' test/router.test.mjs
node --test --test-name-pattern='all upstreams, partial timeout|router APIs public|quota without internal key' test/observability.test.mjs
node --test --test-name-pattern='quota presentation|quota relative date|available percent|manual SSE start|SSE Stop/Start|log scroll' test/web.test.mjs
TZ=America/New_York node --test --test-name-pattern='Madrid hover|shared countdown|no circuit header' test/web.test.mjs
```
Resultados: 8/8 quota-routing; 9/9 UI lifecycle/headers/dates; 7/7 regresión
routing/breaker/auth/streaming; 3/3 reader/panel/auth; 7/7 cuotas/SSE/scroll;
4/4 selección TZ alterna (incluye fixed clock porque su nombre contiene Madrid
hover). Total 38 ejecuciones exitosas dirigidas, con solapamientos entre
selecciones; no 38 tests únicos. Sintaxis exit 0.

Cuotas: HTTP loopback reales para gating independiente UI, selección siguiente,
cache sin consultas repetidas, all-unavailable Retry-After, auth pública/proxy;
reloj Date mock para expiry, single probe, stale-generation éxito/fallo/reset,
unknown/null/past/malformed, 500 no cuota inventada, ECONNRESET umbral/fallback,
stale cache, red timeout y reset confirmado sin extensión posterior. Normalización
estricta y DST testados sin dependencia de TZ local. UI DOM/VM verifica inicio
exactamente uno aun fallando, manual retry, no timers/no autoSSE, lifecycle y
cabecera sin countdown, hover Madrid, quotas/color, dedupe y scroll sintético.
Primera ejecución cuota fue 6/7 por defaults del helper de test que reemplazaban
undefined por valores válidos; corregido fixture con asignación explícita, última
8/8 exit 0. Sin fallo de implementación oculto por ese ajuste.

### Límites
No .env, tokens, archivos auth, prompts ni cuerpos privados leídos. Sin APIs
live de cuentas/modelos, Docker, compose rendering, build, deploy, audit,
instalación de paquetes ni suite global. DOM/VM y CSS estático no validan layout,
scroll/bfcache reales. Estado en memoria y cache local al proceso; no persistencia
ni coordinación multiproceso. Cuenta desconocida no bloquea por cuota: conserva
protección genérica por errores; una cuota confirmada sí conserva su fecha
hasta vencimiento. Observación no inicia half_open ni verifica salud real.
Git padre muestra carpeta untracked: diff no prueba cambios sobre baseline;
la evidencia son fuente inspeccionada y comandos dirigidos registrados aquí.

## Revisión y corrección — 2026-10-07: cuota positiva y origen de recuperación

### Diagnóstico y alcance
Leídos skill Sequential API proxy review y sus referencias, fuentes actuales,
pruebas y secciones anteriores de README/informe antes de editar. Trabajo local
sobre implementación custom existente, sin delegación ni plataforma nueva.

El código anterior tenía dos diferencias verificables frente al contrato pedido:
`quotaBlockedUntil` elegía máximo de resets agotados; `quotaRecovery` permanecía
retenido tras reset vencido aunque un refresco mostrara ambos consumos 0 (restante
100%). Además `syncQuota` solo aceptaba fechas crecientes y no distinguía el origen
visual de half_open. Esto explica una causa posible de «En recuperación» con cuota
positiva. NO confirma la causa de `(4) sistemes`: no se inspeccionó su runtime ni
cuenta real. `openUntil > 0` también puede corresponder a fallos HTTP/red/reset o
startup y debe recuperarse mediante tráfico real, no mediante porcentajes de cuota.

### Cambios concretos
- `src/observability.mjs`: validación estricta de porcentajes 0..100, helper de
  ambas cuotas positivas, prioridad semanal absoluta, 5h solo con semanal conocida
  disponible. Timestamp finito futuro Unix segundos; semanal agotada con reset
  inválido/pasado no cae al reset 5h. Ambas positivas no bloquean por fechas.
- `src/server.mjs`: effectiveQuota puro compartido por snapshot y sincronización.
  Evidencia fresca positiva cancela únicamente la retención de cuota cuando no
  hay sonda activa. Datos unknown/stale conservan fecha confirmada; caducidad sola
  conserva recovery. Evidencia agotada válida reemplaza la fecha anterior incluso
  si es menor (prioridad semanal), incrementando generation. Liberación cuota-only
  invalida tráfico viejo; no borra counters/openUntil ni salud genérica.
- Sonda identificada por objeto reservation además de generation: nuevo bloqueo
  invalida completados, pero no suelta la exclusión mientras la sonda previa siga
  activa. Su finalización/release libera solo su propia reserva; éxito obsoleto no
  cierra bloqueo nuevo. Refresh positivo con sonda en vuelo conserva half_open.
- Snapshot añade recoveryOrigin generic/quota/generic_and_quota/null; UI explica
  origen de half_open sin derivar salud de porcentajes ni esconder una sonda real.
  GETs no mutan circuitos; snapshot efectivo anticipa el mismo resultado que acquire.
- Tests adaptan fixtures con semanal disponible explícita y expectativa del campo
  aditivo. Nuevos casos cubren prioridad con timestamps distintos, ambos restante
  100%, liberación previa/posterior al reset, unknown/null/invalid/stale, recuperación
  genérica, generaciones obsoletas y sonda concurrente. HTTP loopback prueba refresh
  readonly -> status -> selección real coherentes sin tráfico al observar.
- No cambios a auth, forwarding/failover, streaming, startup/manual refresh, parser
  SSE/autoscroll/dedupe, config, dependencias o proyectos vecinos.

### Verificación final (dirigida; no suite global)
```bash
npm run check
node --check test/quota-routing.test.mjs
node --check test/web.test.mjs
node --check test/router.test.mjs
node --test test/quota-routing.test.mjs
node --test --test-name-pattern='recovery origin|summary trusts|startup refresh|manual SSE start|SSE Stop/Start|log scroll' test/web.test.mjs
node --test --test-name-pattern='permite una sola sonda|generación antigua|abre el circuito tras tres|protege las rutas|RUNTIME_FAILOVER desactivado devuelve|reenvía el mismo cuerpo|transmite respuestas' test/router.test.mjs
node --test --test-name-pattern='all upstreams, partial timeout|router APIs public|quota without internal key' test/observability.test.mjs
```
Resultado final: sintaxis exit 0; **15/15 cuotas, 7/7 UI/SSE, 7/7 router,
3/3 reader/panel: 32 pruebas dirigidas pasan**. No suite global.
En primeras ejecuciones hubo expectativas DOM equivocadas de separadores/resumen
(el render incluye 0 deshabilitados) y un deepEqual heredado sin recoveryOrigin;
corregidas expectativas, no ocultados fallos. Reejecución final encadenada con &&
completó todos los comandos exit 0.

### Límites y uso del diagnóstico
Sin .env, archivos auth, tokens, llamadas reales, Docker/build/deploy, audit,
instalación o reinicio. HTTP contra mocks loopback y DOM/VM, no browser visual.
No se demuestra salud ni origen real de sistemes ni adopción por servicio desplegado.
Con fuente actual: quota-only + evidencia fresca inequívoca de ambas disponibles
sin sonda activa => elegible; generic/mixto => recuperación real hasta éxito vigente.
Una sonda en vuelo no se omite por refrescar. El código está corregido localmente,
no desplegado. Caché y estados siguen en memoria; si evidencia positiva caduca
antes de un boundary, readonly no persistió liberación y se conserva la retención
previa hasta nueva evidencia o sonda. Eso es conservación explícita, no salud inventada.

## 2026-10-07 — Origen cliente de socket en logs existentes

### Inspección y contrato conservado
Leídos skill sequential-api-proxy-review y referencia read-only-observability,
logger, sanitizer/hub, index, config, servidor, visor y pruebas afectadas antes
de cambiar. Orden de upstreams desde config; inicio secuencial por petición;
startup opcional con presupuesto igual al umbral; failover runtime opcional
(default false), estados 401/403/408/429/500-599; timeout/red cuentan fallos.
Auth API independiente del panel público, cuerpos limitados y streaming intacto.
ECONNRESET atribuible cuenta una vez por petición, sin failover de esa petición;
idle no penaliza; generaciones/sonda única/cooldown y reglas de cuotas intactas.
No política trusted-proxy existente: buildRequestHeaders usa socket para XFF,
logging nuevo usa exclusivamente peer y no cambia forwarding.

### Archivos y diseño
- Nuevo src/client-address.mjs: formateador socket + validación IP con node:net,
  bounded 64 chars, normalización ::ffff:IPv4, IPv6 bracketed solo con puerto,
  omisión 80/443/unknown, valores arbitrarios/inyección rechazados.
- src/server.mjs: captura IP/puerto remoto al inicio; AsyncLocalStorage por
  servidor añade clientAddress solo a eventos existentes con el mismo requestId.
  clientError ejecuta correlación desde contexto activo del socket, conservando
  peer capturado aunque el socket haya cerrado. Sin registro/map adicional por
  requestId, log nuevo o alteración de breaker/cuotas/forwarding.
- src/observability.mjs: allowlist específica preserva clientAddress saneado.
  src/logger.mjs no necesita cambios: serializa los campos admitidos y los pasa
  al hub, que vuelve a sanitizar antes de SSE.
- src/web/app.js: valida independientemente IPv4/IPv6/puerto (no string libre),
  incluye campo en metadata y conserva textContent, parser, cap/dedupe/scroll.
- package.json: check incluye el módulo nuevo; sin dependencias nuevas.
- test/observability.test.mjs, test/router.test.mjs, test/web.test.mjs: IP v4,
  mapped, v6, 80/443, otros puertos y unknown; inyección/valores arbitrarios;
  XFF/Forwarded spoof ignorados; stdout JSON -> SSE real loopback y hub -> visor
  DOM/VM; mismo origen en failure/circuit/retry/completion y clientError activo,
  reset de streaming sin failover/ruido nuevo. README documenta peer, puerto
  efímero detrás proxy y exposición pública de IP.

### Verificación final dirigida
```bash
npm run check
node --check src/client-address.mjs
node --check test/observability.test.mjs
node --check test/router.test.mjs
node --check test/web.test.mjs
node --test --test-name-pattern='clientAddress|logs allowlist|stdout redacts|router APIs public|SSE stable|empty log' test/observability.test.mjs
node --test --test-name-pattern='clientAddress|ECONNRESET|clientError|RUNTIME_FAILOVER desactivado|reenvía el mismo cuerpo|transmite respuestas|protege las rutas|permite una sola sonda' test/router.test.mjs
node --test test/web.test.mjs
```
Resultado: exit 0, **6/6 observability, 12/12 router, 30/30 visor: 48/48**.
Primero falló un fixture UI que no esperó consumir todos sus frames; corregida
espera por frame. El fixture de streaming esperaba response_stream_error extra,
pero teardown existente aborta controller y solo registra upstream_client_error;
ajustada expectativa al contrato observado sin cambiar comportamiento servidor.
Reejecución final encadenada completa exit 0. check también se reejecuta después
de incorporar el módulo a package.json.

### Límites
Sin suite global, audit, dependencias instaladas, .env/archivos auth/tokens,
Docker/build/deploy, servicios live, reinicios ni delegación. Mocks HTTP loopback
(sin cuentas reales) y DOM/VM/CSS; no validación visual en navegador real. IPv6 y
puertos 80/443 cubiertos con fixtures, no conexiones reales IPv6 ni puertos
privilegiados. Logs de rutas que antes no emitían eventos siguen sin emitirlos;
eventos globales/sin requestId no reciben origen. IP inválida se omite; no es un
campo de autenticación ni identifica de forma fiable usuario tras proxy/NAT.

## Tokens/persistencia — 2026-10-07 (contrato nuevo vigente)

**Funcional y verificado en source/local mocks; NO desplegado. Sin delegación.**
Leídos skill Sequential API proxy review y referencias, fuentes actuales,
README/Compose/Dockerfile e informe histórico. Preflight documentación oficial
node:sqlite v22: disponible sin flag desde 22.13, aún experimental. Se mantiene
Node 22 fijando imagen 22.23.3; SQLite builtin en worker, sin dependencias ni
servicios pagados, elegido frente a JSONL por índices/recovery/query bounded.

Archivos router: nuevos src/usage.mjs, usage-store.mjs, usage-worker.mjs,
test/usage.test.mjs; integración server/index/config, sanitizers backend/visor,
test web, package/lock/check, Dockerfile y merge Compose named volume. README
incluye contrato v1, consultas/exportación, exposición, límites, backup/retención.
Hermano: patch-openai-oauth.mjs, test/patch-openai-oauth.test.mjs y README: parche
estricto `?? null` frente a `?? 0`; no edición de baseline .inspection archivado,
no cambios de pins OAuth 2.0.0/Codex latest ni obligación de construir hermano.

- JSON selectivo incremental y SSE UTF8/CRLF/multilínea: no buffer cuerpo/evento
  entero; límites 16 MiB trabajo, depth64, key/string256, literal128. Gzip/encoding,
  límites/malformed → unknown, forwarding idéntico y backpressure.
- Un terminal usage_attempt por intento iniciado en finally (incluido cancel,
  transport/failover), persistencia UNIQUE requestId+attempt; no suma chunks,
  detalles subconjuntos, ausentes null, cero explícito conservado. HTTP outcome
  separado de Responses modelStatus. Failover descartado unknown; no total global
  de consumo ni coste/quota estimados. Chat siempre provenance cero ambiguo, incluso
  con parche porque no se verifica despliegue ni contabilidad SDK.
- SQLite WAL/FULL en worker, queue256 compartida, timeout5s, errores/drop visibles
  sin path/error libre, graceful drain (también cola llena), schema futuro rechazado.
  Query pública GET /router/usage: fechas requeridas UTC [from,to), máximo31d,
  limit<=500, cursor id/account validado; sin SQL/path libre. No agregación/gráfico
  ahora: export paginado apto para agrupar fuera, deduplicando ids.
- Persistencia sin IP/model/body/tools/auth/query; logs conservan peer IP existente.
  Volume durable Compose con path configurable, nonroot uid1000/directorio0700.
  Sin TTL/rotación/borrado sorpresa; crecimiento/backup explicado. SIGKILL puede
  perder queue/intent activo; no promesa de consumo real ni exactly-once a disco.

### Evidencia ejecutada
Runtime local **Node 26.7.0**, mock HTTP loopback, SQLite fichero temporal y DOM/VM:

```bash
npm run check
node --test test/usage.test.mjs
node --test --test-name-pattern='usage scalar viewer|manual SSE start|clientAddress' test/web.test.mjs
node --test --test-name-pattern='usage patch|rechaza versión' ../openai-oauth-docker/test/patch-openai-oauth.test.mjs
node --test --test-name-pattern='reenvía sin alterar|reenvía el mismo|RUNTIME_FAILOVER|transmite respuestas|clientAddress|clientError después' test/router.test.mjs
node --check ../openai-oauth-docker/patch-openai-oauth.mjs
node --check ../openai-oauth-docker/test/patch-openai-oauth.test.mjs
env -u ROUTER_API_KEY docker compose --env-file /dev/null config --quiet
```

Resultados finales: **11/11 usage + 3/3 UI/SSE + 2/2 patch + 8/8 forwarding = 24/24
dirigidos**, sintaxis y Compose render exit0. Usage incluye persist/reopen,
dedupe/cursor/rango/account, ausencia secretos/IP, disk error, queue drop/drain,
future schema, abort antes/después usage, JSON/SSE repetidos/DONE, invalid/0/null,
encoding/gzip/depth/bytes, slow downstream byte-mode/backpressure, proxy auth y
bytes/headers/cuerpo request inalterados. UI prueba allowlist independiente. Patch
prueba conversión aislada npm real, null/zero, idempotencia y ancla ausente; rechazo
versión/anclas incompatible también dirigido. No nueva escritura en archived
baseline: fixture usage en tmpdir, referencias históricas se leen como baseline.

Durante desarrollo el primer test de backpressure usaba Readable.from en modo
objeto (8192 objetos de highWaterMark) y falló; se corrigió fixture a modo bytes.
Prueba final demuestra source bloqueado con downstream parado, no velocidad real
ni medición visual. Resultados intermedios no sustituyen los finales indicados.

### Límites y despliegue
No suite global, audit, llamadas live, secretos/.env, Docker build/deploy/restart,
ni runtime real de imagen Node22/volumen nonroot. Compose render no acredita
permisos runtime. node:sqlite experimental Node22 es riesgo documentado; API
empleada compatible según documentación oficial pero verificación real Docker
queda al operador. No gráfica ni agregación SQL: paginado mínimo utilizable,
agrupación externa explicada. No precio/cuota/consumo real verificado.

Operador: `docker compose build && docker compose up -d` en router cuando autorice
su release; conservar named volume y config (NO down -v), comprobar permisos y
consulta/logs. Hermano opcional bajo su procedimiento para preservar unknown;
router no depende de reconstruirlo. README contiene ejemplo curl y backup.

Fuera de alcance / suggest_task: verificar contabilidad/provenance en AI SDK y
runtime OAuth real con autorización explícita; revisar métricas del volumen y
política de archivo si el volumen de tráfico exige retención. No se han alterado
routing, quotas, secrets ni safety configs para resolver estos temas.


## Ampliación 2026-10-07 — gráfico diario de tokens
Implementado y verificado localmente, **NO desplegado**. Esta sección sustituye la
limitación anterior «sin agregación/gráfico»; no altera los registros históricos.

### Cambios
- `src/usage-summary.mjs`: validación estricta, rango calendario default 30 días
  incluyendo hoy, máximo 31; medianoches Europe/Madrid via Intl, DST 23/25h.
- `src/usage-worker.mjs`: SQL parametrizado GROUP BY de rangos diarios (LEFT JOIN
  para días vacíos), sum/count independientes para cinco métricas; alias históricos
  del rango max500. Nunca entrega historial completo ni suma página inicial.
- `src/usage-store.mjs`, `src/server.mjs`: summary en worker y GET público
  `/router/usage/summary`, error 400/503 saneado; asset usage-chart.js allowlisted.
- `src/web/index.html`, `usage-chart.js`, `style.css`: sección bajo logs; cuenta,
  métrica y fechas, total reportado, SVG de línea/puntos con huecos desconocidos,
  parciales huecos, foco/puntero/toque, tooltip español y lista de datos accesible.
  External assets/textContent/createElementNS, CSP sin cambios, sin inline styles.
  Consulta inicial/status alias; refresh/selector independiente de cuotas/SSE,
  dedupe/cancel y guardas contra fetch/JSON obsoletos, cleanup pagehide.
- `package.json`: check incluye nuevos módulos. README documenta API/semántica.
- `test/usage-summary.test.mjs`, `test/usage-chart.test.mjs`: cinco nuevos tests
  dirigidos con múltiples casos; regresiones existentes no modificadas.

Preflight: documentación oficial Chart.js consultada (alternativa gratuita
mantenida). Elegido SVG nativo adecuado para <=31 puntos, sin dependencia/CDN,
con foco DOM y fallback textual. Referencia inbound leída desde ruta media segura:
tarjeta oscura, línea azul, grid tenue, ejes/total; adaptación al theme del panel,
sin inventar selector de modelos ni series/modelos ausentes en almacenamiento.

Contrato preservado: config mantiene orden de upstreams, runtimeFailover y
startup healthcheck, auth proxy/body limits/timeouts/status retry; server breaker
mantiene fallos/resets, cooldown/recovery y forwarding JSON/SSE. Resumen no llama
upstreams, readQuotas ni reserva sondas. Origen/CSP/assets/log200 IDs/autoscroll y
Start/Stop sin cambios. No ediciones al proyecto hermano, .env ni credenciales.

### Evidencia ejecutada
- `npm run check`: exit 0, incluye usage-summary y usage-chart.
- `node --test test/usage-summary.test.mjs test/usage-chart.test.mjs test/web.test.mjs test/observability.test.mjs test/usage.test.mjs`:
  **62/62**, 0 fallos/cancelados/omitidos, dos ejecuciones tras implementación
  (última tras ajustes de selector y entero seguro). Evidencia incluye:
  - SQLite 510 filas conocidas +2 desconocidas en día DST: input sum0 known510
    unknown2; output sum1020 known510 unknown2; duplicate requestId/attempt ignorado.
  - Ambos DST Madrid (29 marzo 23h, 25 octubre 25h), límites exactos,
    día siguiente independiente, vacío frente unknown, cuenta histórica/filtro.
  - HTTP local API pública, Origin403, parámetros400/caps/duplicados, DB503
    saneado, proxy401 intacto y asset JS200/CSP; sin llamadas upstream reales.
  - DOM/VM: hover/foco/click/touch, locale español, null/0/parciales, ausencia de
    línea falsa por gaps, selector, dedupe/abort y race tanto fetch como JSON,
    error y recuperación manual. SSE regresión Stop/Start/cap200/dedupe/autoscroll.

### Límites y despliegue pendiente
Verificación UI **DOM sintético/VM**, no navegador visual/touch físico ni bfcache
real. SQL output limitado, trabajo proporcional a filas del rango; conserva
cola256/timeout5s y ausencia de TTL. No prueba global/router suite completa,
audit, Docker build/runtime/deploy, APIs de modelos/cuotas reales. Sin migración
schema ni nuevas dependencias. No se exige modificar el hermano.

Operador, cuando quiera desplegar (no ejecutado aquí):
```bash
cd /home/prova/.openclaw/workspace-oauth-chatgpt/router-openai-oauth
docker compose build
docker compose up -d
```
Conservar volumen router-usage y configuración existente. Verificar `/health`,
`/router`, `/router/usage/summary` y permiso del volumen; comprobar con datos reales
sin interpretar sumas upstream como precio/cuota/consumo exacto. No borrar DB/WAL.

## Arranque sin inferencias — 2026-10-08 (contrato vigente)

Implementado y verificado localmente, **sin despliegue**. Esta sección sustituye
las menciones históricas a validación real/healthchecks de arranque.

### Decisión y archivos
- Retirada completa, no un cambio a `enabled=false`: eliminados descubrimiento
  `/v1/models`, prompt aritmético, inferencia, reintentos y exports
  `checkUpstreams`/`validateUpstreamsAtStartup` de `src/server.mjs`.
- `src/config.mjs` y `compose.yaml`: retiradas las tres variables
  `STARTUP_HEALTHCHECK_*` y su parsing. Valores antiguos ya no tienen efecto.
  Conservados resto de Compose, timeout runtime180000, umbrales3/5 y cuotas.
- `src/index.mjs`: crea servidor/listener sin esperar validaciones upstream;
  `server_started` deja de incluir el flag retirado.
- Eliminado `initialUpstreamHealth` y sus eventos/estado de arranque. Breaker
  empieza cerrado, contadores0, generación0. `createCircuitBreaker` conserva
  su export runtime; el tercer argumento es ahora el callback de snapshot de cuota.
  Elegibilidad closed no acredita salud OAuth.
- `test/router.test.mjs`: retiradas pruebas de la funcionalidad eliminada;
  `test/startup.test.mjs`: tres regresiones nuevas de configuración, listener
  y entrypoint real como proceso hijo con DB temporal y entorno explícito sin
  heredar credenciales. Mocks HTTP loopback registran cero solicitudes upstream
  al arrancar, incluidas models, responses, chat y cuotas. Health/status readonly
  no hacen I/O; tráfico posterior consulta cuotas y proxifica Responses bajo demanda.
- `test/quota-routing.test.mjs`: actualizada firma runtime del breaker.
  `test/observability.test.mjs`: circuito abierto mediante tres fallos HTTP runtime,
  no inyección de estado inicial; conserva comprobaciones readonly y SSE.
  `test/usage.test.mjs` y `test/usage-summary.test.mjs`: eliminada variable obsoleta
  de fixtures (comprobada sintaxis, no ejecutadas esas suites).
- README: actualizado exclusivamente contrato/configuración de arranque y nota
  de contabilización relacionada. El arranque no consume tokens de modelo;
  tráfico proxificado posterior, fallos y failover sí pueden consumirlos.

### Verificación ejecutada
Runtime local Node26.7.0:

```bash
node --test test/startup.test.mjs test/router.test.mjs test/quota-routing.test.mjs
node --test --test-name-pattern='router APIs public' test/observability.test.mjs
node --check src/config.mjs && node --check src/index.mjs && node --check src/server.mjs && node --check test/startup.test.mjs && node --check test/observability.test.mjs && node --check test/usage.test.mjs && node --check test/usage-summary.test.mjs
```

**44/44** (arranque3 + router26 + cuotas15), más **1/1** observabilidad dirigido:
**45/45 pasan**, cero fallos/cancelados/omitidos; sintaxis exit0.
Regresiones cubren orden, auth/passthrough, cuerpos multimodales, streaming sin
retry tras headers, failover true/false, resets por requestId, timeout, umbrales,
cooldown, sonda única half-open, generaciones antiguas y recuperación de cuotas.
No se añaden sondas runtime independientes ni polling/healthchecks de modelos.

Sin suite global, audit, instalaciones, Docker/Compose render/build/deploy,
restart ni APIs live. No se leyeron `.env`/credenciales ni se modificó el proyecto
hermano. Sin nuevas dependencias ni cambios de almacenamiento/consumo.
