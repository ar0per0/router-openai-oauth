# router-openai-oauth

Proxy OpenAI-compatible con failover secuencial para varias instancias de
`openai-oauth-docker`.

```text
Aplicación ──> router-openai-oauth ──> upstream 1 (primario)
                                      ├─> upstream 2 (si falla el primero)
                                      └─> upstream N (si fallan los anteriores)
```

La aplicación configura una única URL base:

```text
http://router-openai-oauth:10530/v1
```

El router conserva método, ruta, query, cuerpo y cabeceras, y devuelve la
respuesta del upstream seleccionado. No modifica el formato OpenAI.

Panel web para visualizar el estado/consumo de los upstream. Permite ver el consumo de tokens.
```text
http://router-openai-oauth:10530/router/
```
![Captura1](./captura11.png)
![Captura2](./captura2.png)

---

## Inicio rápido

docker-compose.yaml
```yaml
services:
  router-openai-oauth:
    image: ar0per0/router-openai-oauth:latest
    init: true
    restart: unless-stopped
    environment:
      TZ: Europe/Madrid
      UPSTREAMS: "principal=http://192.168.1.15:10531" # Upstreams en orden de prioridad; separa varias URLs con "|".
      UPSTREAM_TIMEOUT_MS: 180000 # Tiempo máximo de espera por inactividad de cada upstream, en milisegundos.
      UPSTREAM_FAILURE_THRESHOLD: 3 # Número de errores consecutivos antes de desactivar temporalmente un upstream.
      CLIENT_ERROR_FAILURE_THRESHOLD: 5 # Durante el diagnóstico, devuelve el error observado sin probar el siguiente upstream.
      MAX_REQUEST_BODY_BYTES: 33554432 # Tamaño máximo permitido del cuerpo de una petición, en bytes.
      RETRY_STATUS_CODES: "401,403,408,429,500-599" # Estados HTTP que hacen que el router pruebe el siguiente upstream.
      ROUTER_API_KEY: "" # Clave Bearer opcional para proteger el acceso al router; vacía significa sin autenticación.
      RUNTIME_FAILOVER: true # Durante el diagnóstico, devuelve el error observado sin probar el siguiente upstream.
      QUOTA_TIMEOUT_MS: 10000 # Lectura de cuotas compartida por routing y panel; timeout por instancia.
      QUOTA_CACHE_MS: 15000 # Caché/deduplicación bajo demanda; sin monitor ni polling.
    ports:
      - "10530:10530"
    volumes:
      - router-openai-oauth:/app/data

```
---

## Política de selección y failover

Durante esta fase de diagnóstico, el Compose configura:

```yaml
RUNTIME_FAILOVER: false
```

Con este valor, cada petición usa el primer upstream disponible. Si ese
upstream devuelve un error, el router registra y devuelve ese mismo error sin
probar el siguiente dentro de la misma petición. Los contadores y el circuit
breaker siguen funcionando; cuando un upstream queda temporalmente abierto,
las peticiones posteriores comienzan por el siguiente disponible.

El failover secuencial por petición puede recuperarse más adelante con
`RUNTIME_FAILOVER=true`. En ese modo:

- cada `ECONNRESET` cuenta como máximo una vez por petición entrante y
  `requestId`;
- la petición que recibe el reset termina sin probar otro upstream;
- al acumular `CLIENT_ERROR_FAILURE_THRESHOLD` peticiones distintas, abre el
  circuito del upstream;
- la petición siguiente, con un `requestId` nuevo, comienza en el siguiente
  upstream disponible;
- los estados HTTP configurados, timeouts y otros errores de transporte
  mantienen el failover secuencial normal.

Por ejemplo, con un umbral de `5`, deben fallar cinco peticiones diferentes
contra `eduard`. La sexta petición empieza en `anna`. Los logs muestran el
progreso en el prefijo:

```text
[router-openai-oauth] [eduard] [4/5] WARN 2026-10-03 14:26:25 upstream_client_error {...}
```

Cada petición comienza siempre por el primer upstream y avanza en orden solo
cuando sucede una de estas condiciones:

- error de conexión o DNS;
- timeout sin actividad;
- HTTP `401` o `403` del upstream, que puede indicar credenciales OAuth
  caducadas o sin permisos en esa instancia;
- HTTP `408`;
- HTTP `429`;
- HTTP `500` a `599`.

Otros errores `4xx`, como `400` o `422`, se devuelven directamente porque
normalmente indican un problema en la petición que otro upstream no resolverá.
Los códigos que activan el salto se pueden cambiar con `RETRY_STATUS_CODES`.

## Protección contra errores repetidos

Cada upstream mantiene un contador de errores consecutivos. Cuando alcanza
`UPSTREAM_FAILURE_THRESHOLD` —3 de forma predeterminada—, su circuito se abre
y el destino se omite durante un fallback interno de 10 minutos para errores
sin evidencia de cuota válida. Un éxito de la generación vigente reinicia el contador.
La variable histórica `UPSTREAM_COOLDOWN` sigue aceptándose por compatibilidad
(`ms`, `s`, `m`, `h`, `d`); ya no se necesita en Compose y no fija el reset de cuota.

Al terminar el periodo, solo una petición prueba el upstream. Si funciona, se
rehabilita; si falla, se vuelve a omitir durante otro periodo completo. Si
todos están temporalmente deshabilitados, el router responde HTTP `503` e
incluye `Retry-After`.

Este estado se conserva únicamente en memoria y se reinicia al recrear o
reiniciar el contenedor.

Los cambios de estado aparecen en los logs con el alias correspondiente:

```text
[router-openai-oauth] [principal] WARN ... upstream_failure {"alias":"principal","failures":1,"threshold":3}
[router-openai-oauth] [principal] WARN ... upstream_circuit_open {"alias":"principal","failures":3,"cooldownMs":600000,...}
[router-openai-oauth] [principal] INFO ... upstream_circuit_half_open {"alias":"principal",...}
[router-openai-oauth] [principal] INFO ... upstream_circuit_closed {"alias":"principal",...}
```

Para evitar ruido, no se escribe una línea por cada petición que omite un
upstream mientras su circuito permanece abierto.

El cuerpo de la petición se mantiene en memoria para poder reenviarlo. El
límite predeterminado es 32 MiB y se configura con `MAX_REQUEST_BODY_BYTES`.
Las respuestas se transmiten en streaming sin almacenarlas completas.

Antes de las cabeceras, `UPSTREAM_TIMEOUT_MS` es un plazo absoluto desde el
inicio de cada intento; recibir actividad sin cabeceras no reinicia ese plazo.
Después de las cabeceras mide inactividad del socket de respuesta, no duración
total del stream. No existe deadline global: la petición incluye lectura de
cuotas (instancias en paralelo, hasta `QUOTA_TIMEOUT_MS`, salvo caché), más hasta
N intentos secuenciales con `RUNTIME_FAILOVER=true` y N upstreams elegibles.
También incluye recepción del cuerpo, procesamiento y envío al cliente; no es
correcto prometer un límite total de N × timeout. Un stream activo puede durar
más que ese producto; después de enviar cabeceras no se hace failover.

Compatibilidad de cuerpos con el hermano corregido: el router admite hasta
32 MiB por defecto, pero el adaptador HTTP de openai-oauth-docker limita la
entrada a **16 MiB**. Un cuerpo >16 MiB y <=32 MiB puede pasar el router y ser
rechazado por el hermano antes de adquirir sesión o iniciar inferencia. El
parche v2 del adaptador devuelve HTTP **413** con un mensaje público saneado.
Con la configuración predeterminada, 413 no es retryable y el router devuelve
el rechazo sin intentar otro upstream. Reducir
`MAX_REQUEST_BODY_BYTES` a 16777216 al configurar ese despliegue permite rechazar
antes con 413 `request_body_too_large` del router. No se cambia el default ni
se afirma que la imagen desplegada tenga ese parche. Este límite de entrada no
es el límite independiente de 16 MiB del observador de respuestas.


Una vez que el router ha empezado a enviar una respuesta al cliente ya no puede
cambiar de upstream. Si un stream se corta a mitad, se cierra la conexión y la
aplicación cliente decide si reintenta.

> Una petición que llega al upstream pero termina en `5xx` puede haber consumido
> cuota antes del failover. El siguiente intento es una petición nueva.

## Configuración

| Variable | Predeterminado | Descripción |
|---|---:|---|
| `HOST` | `127.0.0.1` | Dirección donde escucha el router. |
| `PORT` | `10530` | Puerto del router. |
| `TZ` | `Etc/UTC` | Zona horaria IANA usada en las marcas de tiempo de los logs. |
| `UPSTREAMS` | `http://127.0.0.1:10531` | Upstreams ordenados, con alias opcional y separados mediante `\|`. |
| `UPSTREAM_TIMEOUT_MS` | `180000` | Plazo absoluto hasta recibir cabeceras; después, timeout por inactividad del socket de respuesta, por intento. |
| `UPSTREAM_FAILURE_THRESHOLD` | `3` | Errores consecutivos runtime antes de omitir un upstream. |
| `CLIENT_ERROR_FAILURE_THRESHOLD` | `5` | Errores `ECONNRESET` consecutivos, entrantes o salientes, que abren el circuito del upstream afectado. Se contabilizan aparte de `UPSTREAM_FAILURE_THRESHOLD`. |
| `RUNTIME_FAILOVER` | `false` | Controla el failover para HTTP, timeouts y otros transportes. Un `ECONNRESET` siempre termina la petición actual y cambia de upstream únicamente en una petición posterior al alcanzar su umbral. |
| `MAX_REQUEST_BODY_BYTES` | `33554432` | Tamaño máximo del cuerpo que puede reintentarse. |
| `RETRY_STATUS_CODES` | `401,403,408,429,500-599` | Estados contabilizados como fallo; activan el siguiente upstream solo con `RUNTIME_FAILOVER=true`. |
| `ROUTER_API_KEY` | vacío | Bearer token opcional para proteger el proxy; no protege el panel. |

Al ejecutar el código directamente, `HOST` usa `127.0.0.1`. La imagen Docker
define `HOST=0.0.0.0` y `PORT=10530`, por lo que no es necesario repetir estas
variables en el Compose.

Cada entrada puede llevar un alias delante de la URL, separado mediante `=`:

```yaml
UPSTREAMS: "principal=http://172.5.0.2:10531 | respaldo=http://172.5.0.4:10531"
```

El alias admite letras, números, punto, guion y guion bajo. Debe ser único. Si
se omite, el router asigna automáticamente `upstream-1`, `upstream-2`, etc. La
URL debe contener únicamente esquema, host y puerto.

También pueden utilizarse nombres DNS de Docker:

```yaml
UPSTREAMS: "cuenta-1=http://openai-oauth-1:10531 | cuenta-2=http://openai-oauth-2:10531"
```

## Docker Compose

El `compose.yaml` incluido publica el router en el puerto `10530` y utiliza la
red bridge predeterminada. Los upstreams pueden estar en otra máquina o
contenedor siempre que sus direcciones sean accesibles desde el router:

```bash
docker compose build --no-cache
docker compose up -d
docker compose logs -f
```

Desde otra aplicación o contenedor con acceso al servidor:

```text
http://router-openai-oauth:10530/v1
```

El Compose publica el puerto en todas las interfaces del servidor:

```text
http://IP_DEL_SERVIDOR:10530/v1
```

Esto permite acceder desde el propio host y desde la LAN. Configura
`ROUTER_API_KEY` o limita el acceso mediante firewall, especialmente si el
servidor tiene puertos accesibles desde Internet.

## Autenticación opcional

Si configuras:

```yaml
ROUTER_API_KEY: "una-clave-larga-y-aleatoria"
```

la aplicación debe enviar:

```http
Authorization: Bearer una-clave-larga-y-aleatoria
```

La clave del router no se reenvía a los upstreams. Se sustituye por el valor
ficticio `Bearer openai-oauth`, ya que el proxy OAuth no exige una API key.
No guardes la clave directamente en un Compose que se vaya a publicar; inyéctala
desde un gestor de secretos o desde un archivo `.env` protegido.

## Estado, cabeceras y logs

El endpoint básico de salud no consume cuota ni comprueba los modelos:

```bash
curl http://127.0.0.1:10530/health
```

Respuesta:

```json
{"status":"ok","upstreams":2}
```

El estado del circuit breaker se consulta mediante `/router/status`. Esta ruta
es público para consulta local y no muestra las
URLs ni las credenciales de los upstreams:

```bash
curl \
  http://127.0.0.1:10530/router/status
```

Respuesta de ejemplo:

```json
{
  "status": "ok",
  "runtimeFailover": true,
  "upstreams": [
    {
      "index": 1,
      "alias": "principal",
      "state": "open",
      "failures": 0,
      "clientErrors": 5,
      "remainingMs": 420000,
      "disabledUntil": "2026-10-03T14:53:28.874Z",
      "probeInFlight": false
    }
  ]
}
```

Los estados posibles son `closed`, `open` y `half_open`. Tras el cooldown solo
una petición puede actuar como sonda; las peticiones concurrentes usan los
otros upstreams disponibles hasta que esa sonda cierre o vuelva a abrir el
circuito.

Las respuestas proxificadas incluyen:

- `x-router-request-id`: identificador para correlacionar logs;
- `x-router-upstream-index`: upstream que respondió, comenzando por `1`;
- `x-router-upstream-alias`: alias del upstream que respondió;
- `x-router-attempts`: número de intentos realizados.

Los logs nunca incluyen cuerpos, prompts, respuestas ni credenciales.
La fecha se escribe como `YYYY-MM-DD HH:mm:ss` usando la zona configurada en
`TZ`. El Compose incluido utiliza `Europe/Madrid`, por ejemplo:

```text
[router-openai-oauth] [principal] INFO 2026-10-03 08:04:21 request_complete {"alias":"principal","status":200,...}
```

Cuando una conexión se cierra con `ECONNRESET`, el router puede atribuir la
desconexión al upstream que atendía la petición. El contador es independiente
para cada upstream y se reinicia después de una respuesta completada
correctamente. Ejemplo:

```text
[router-openai-oauth] [principal] [1/5] WARN 2026-10-03 08:04:21 upstream_client_error {"alias":"principal","reason":"ECONNRESET","clientErrors":1,"threshold":5,...}
[router-openai-oauth] [principal] WARN 2026-10-03 08:05:14 upstream_circuit_open {"alias":"principal","reason":"CLIENT_ERROR_THRESHOLD","clientErrors":5,"cooldownMs":600000,...}
```

Al alcanzar `CLIENT_ERROR_FAILURE_THRESHOLD`, ese upstream se omite durante
el fallback interno de errores genéricos. Como la conexión del cliente que produjo el `ECONNRESET`
ya está cerrada, no es posible responderle mediante otro upstream; el cambio se
aplica a las peticiones siguientes. Un `ECONNRESET` que el servidor HTTP asocia
a una petición activa incrementa el contador incluso si el upstream ya había
enviado las cabeceras, como puede ocurrir con respuestas en streaming. Un cierre
posterior a las cabeceras que no produzca `clientError` no lo incrementa.

Si había varias peticiones simultáneas al mismo upstream cuando se abrió el
circuito, sus respuestas posteriores no pueden rehabilitarlo. Solo la prueba de
recuperación iniciada una vez terminado el cooldown puede volver a cerrarlo.
Los resets de esas peticiones antiguas se registran como `client_error_ignored`
con `reason=STALE_CIRCUIT_GENERATION` y no modifican los contadores. Los
`ECONNRESET` de sockets sin petición activa se omiten. Un reset contabilizado
solo genera `upstream_client_error`, evitando duplicarlo como `client_error` o
`upstream_error`.

### Arranque sin sondas de upstream

Tras cargar y validar la configuración local, el router crea el servidor y abre
el listener sin esperar a los upstreams. No consulta `/v1/models`, no envía
inferencias a `/v1/chat/completions` ni `/v1/responses`, ni lee cuotas al arrancar.
La funcionalidad de comprobación real de arranque y las variables
`STARTUP_HEALTHCHECK_*` se han retirado; valores antiguos de esas variables
ya no tienen efecto. No existe una opción para reactivarlas.

Todos los circuitos empiezan cerrados y con contadores a cero: es elegibilidad
inicial, no una comprobación de salud OAuth. Las cuotas siguen leyéndose bajo
demanda al llegar tráfico o refrescar el panel. Fallos, cooldown y recuperación
half-open se determinan mediante peticiones reales de clientes; no se añaden
sondas de inferencia independientes. El log `server_started` no incluye el flag
retirado ni se generan eventos de validación inicial.

El arranque no consume tokens de modelo. El tráfico proxificado posterior sí
puede consumir tokens/cuota, incluidos intentos fallidos o de failover.

## Desarrollo y pruebas

El proyecto usa únicamente módulos incluidos en Node.js 22:

```bash
npm install
npm run check
npm test
```

## Seguridad

- El valor predeterminado escucha solo en `127.0.0.1`.
- La imagen se ejecuta como el usuario no privilegiado `node`.
- No expongas el router a Internet sin autenticación, TLS y firewall.
- Los upstreams se fijan al iniciar; las peticiones clientes no pueden elegir
  destinos arbitrarios.

## Panel de cuentas y logs

Web vanilla sin dependencias: `/router/`. Panel, estado, consumo y logs no
requieren contraseña, incluso con `ROUTER_API_KEY` configurada. La clave del
router sigue protegiendo las rutas del proxy. Cualquier equipo con acceso al
puerto puede consultar el panel: limita su exposición a tu red local.
La consulta Router → OAuth no requiere clave interna ni Authorization local.
Cada instancia OAuth mantiene su sesión real para autorizarse ante ChatGPT.
El endpoint `/oauth/rate-limits` también es público para clientes con acceso al
puerto OAuth: limita ambos puertos a clientes de confianza de tu red local.

Al abrir `/router` o `/router/` se ejecuta exactamente una vez el mismo flujo
de Refrescar (status adjunto a cuotas en una sola petición), incluso si falla.
Refrescar consulta todas las instancias, incluso circuitos abiertos, sin mutar
contadores ni iniciar sondas. No hay polling ni SSE automático. Start conecta
el visor mediante fetch SSE sin contraseña; Stop aborta solo esa conexión, no el
servicio. Reconexión manual; buffer de 200 eventos y máximo 16 suscriptores;
clientes lentos se desconectan. Se muestran metadatos allowlist, no cuerpos,
prompts, imágenes, URLs, emails ni credenciales. No es un visor de Docker logs:
recibe eventos del logger del router desde su arranque. Cada evento ocupa una
sola línea completa, sin wrapping ni truncado; el desplazamiento horizontal
queda dentro del visor, sin ensanchar la página.

APIs GET de consulta local sin contraseña:
- `/router/accounts/rate-limits`: cache 15 segundos, timeout por instancia 10 s,
  errores parciales, deduplicación en vuelo. `?refresh=1` revalida manualmente.
  Configurables `QUOTA_CACHE_MS` y `QUOTA_TIMEOUT_MS`.
- `/router/logs`: SSE sin Authorization ni token query. IDs SSE estables por
  publicación (UUID del hub + secuencia), también durante replay. Cursor opcional
  `Last-Event-ID`: si está en el ring, reproduce solo posteriores; desconocido,
  evictado o de otro arranque reproduce todo lo retenido, sin inferir pérdidas.
  Cliente conserva líneas al Stop/Start y deduplica por ID, nunca por texto;
  conjunto de IDs ligado a las últimas 200 líneas. Parser/decoder parcial es
  local a cada conexión y se descarta al Stop. Un evento con ID distinto aunque
  tenga texto idéntico se muestra. Sin ID no se deduplica. Pagehide limpia memoria.
  No se muestra lifecycle normal en texto (Conectado/Detenido ni equivalentes):
  botones Start/Stop lo expresan; errores útiles role=status se borran al conectar
  exitosamente. No reconexión automática ni timers de polling.
- `/router/status`: consulta pública; `/health` conserva su contrato.

La UI se titula **Router**; resumen `2 activos · 2 deshabilitados` sin
la palabra upstreams. Activos (`closed`) verdes, deshabilitados (`open`) rojos
 y recuperación (`half_open`) amarilla separada; estados ausentes desconocidos.
El resumen refleja circuitos, no cuotas ni una comprobación de salud OAuth.
Vencimiento no significa activo: hace falta una sonda exitosa.
Cada encabezado lleva posición 1-based del array backend, sin reordenarlo: `(1) eduard`.
Título closed verde sin Activo/Activado separado; open rojo sin cuenta atrás
de reanudación en el encabezado ni Deshabilitado repetido; half_open
amarillo con etiqueta En recuperación y unknown sin color de salud. Sin
Cooldown ms ni Fallos; conserva errores cliente positivos y sonda en curso.
`circuit.disabledUntil` es ISO: backend solo lo proporciona en `open`, null
en `closed`/`half_open`. La API conserva esa fecha para consumidores; la UI ya no la muestra en el título.
El error de cuenta se muestra solo si existe, nunca `Error: ninguno`.
Solo primary → **Límite 5h**, secondary → **Límite semanal**; no se
presume duración 5h/semanal: el contrato OAuth no la garantiza. Disponible =
`100 - usedPercent`: `Restante 69% · Se restablece en 2d 1h 5m`.
Verde >25%, amarillo >0 y ≤25%, rojo 0%; null/inválidos/fuera de rango quedan
desconocidos sin color. Resets son Unix segundos, no milisegundos.
Las cuotas mantienen duración y hover `title` con fecha exacta
`DD-MM-YYYY HH:mm`. Duración: días/horas/minutos positivos (minutos truncados),
menos de un minuto `<1m`; vencido `pendiente de actualización`, sin negativos
ni afirmar que el backend ya ha restablecido cuota/circuito. Recalcula al
render/refresco manual, sin timers, polling ni peticiones adicionales.
Todas las fechas UI (actualización, hover y metadatos SSE timestamp/time/
disabledUntil) usan Intl.DateTimeFormat con **timeZone Europe/Madrid explícita**,
independiente de zona de navegador/host. UTC previo iba dos horas por detrás
en octubre antes del cambio de horario (+2); en invierno Madrid es UTC+1.
IANA resuelve DST verano/invierno. No cambia TZ del servidor ni ISO/Unix backend.
Fechas numéricas circuito/log son milisegundos; solo campos fecha se formatean,
no contadores/duraciones. JSON backend conserva unidades/precisión. Sin IDs,
plan, créditos ni sección duplicada por ID. Cuentas: dos columnas iguales
minmax(0,1fr), una hasta 45rem, texto largo acotado. Título Router, resumen,
Refrescar, Actualizado y tarjetas comparten wrapper central de máximo 72rem.
Main conserva ancho disponible y padding 1.5rem: solo sección logs queda fuera
del wrapper y conserva scroll horizontal interno, sin wrapping ni truncado.
Logs siguen el último evento inicialmente; subir más de 4px desde el fondo
pausa el seguimiento, volver a ≤4px lo reactiva. Mientras está pausado no salta
al fondo; al superar 200 eventos compensa la altura de la fila retirada (si la
fila visible ya se pierde, limita al inicio). Stop/Start conserva posición e
intención y dedupe por ID. Listener scroll sin polling/timers; pagehide limpia
datos y listener, pageshow lo registra de nuevo para restauración bfcache.
Contrato CSS/scroll sintético, no medición visual en navegador real.
La normalización mantiene `usedPercent` consumido, resets Unix segundos,
duraciones reales, múltiples IDs y créditos nullable sin atribuir unidad.
Cooldown genérico no es reset de cuota; un estado closed no prueba salud OAuth.

### Routing por cuotas (sin depender del navegador)
Antes de seleccionar upstream, el backend llama al mismo `createQuotaReader`
de `/router/accounts/rate-limits`: GET `/oauth/rate-limits`, timeout/bytes
acotados, sin Authorization local, caché `QUOTA_CACHE_MS` y deduplicación
en vuelo. Solo hay lecturas bajo demanda al llegar tráfico o Refrescar,
no monitor/timers de consulta ni llamadas de modelo adicionales. `/router/status`
no provoca lecturas. Los timers existentes de timeout/SSE permanecen.

El aggregate `rateLimits.rateLimits.primary/secondary` es la fuente cuenta-wide:
`usedPercent === 100` y `resetsAt` numérico, finito, futuro, Unix segundos ×1000.
Se respeta el reset más restrictivo entre ambas ventanas agotadas. IDs de modelo
no bloquean la cuenta completa porque su aplicabilidad no es inequívoca.
Un 500/ECONNRESET nunca implica cuota cero; unknown, inválido o snapshot stale
no crea ni extiende bloqueos. Un reset confirmado al seleccionar se conserva
hasta su fecha aunque después falle la lectura; un reset vencido nunca se recicla.

El circuit breaker conserva cooldown genérico y bloqueo por cuota separados.
Adquisición/completado aplican evidencia fresca e invalidan generaciones antiguas;
el GET público solo lee y adjunta la misma disponibilidad efectiva, sin mutar
contadores/reservas/generaciones. Al vencer el bloqueo aplicado queda half_open:
una única petición real es sonda, no falso closed. Una cuota posterior >0 no
cierra circuitos ni borra fallos genéricos; solo éxito vigente puede recuperar.
Se omiten bloqueados en orden incluso con RUNTIME_FAILOVER=false; si ninguno
está disponible, 503 + Retry-After del primer vencimiento efectivo. Estado
en memoria, sin persistencia nueva ni modificación de openai-oauth-docker.
La API interna ChatGPT `/wham/usage` es unstable; `account/rateLimits/read`
es RPC de Codex, no una ruta HTTP. Véase README de openai-oauth-docker.

Despliegue posterior por el operador: construir ambas imágenes con
`docker compose build` en cada proyecto y aplicar su procedimiento de despliegue.
Esta implementación no arranca/reinicia servicios. Usar TLS en un reverse proxy
del mismo origen; conservar Host y Authorization, sin buffering de SSE ni logs
de headers. Origin debe coincidir con esquema/Host vistos por Node; en TLS
terminado externamente configurar el proxy para el origen interno equivalente
(no confiar automáticamente en X-Forwarded-*). No habilitar CORS cross-origin.
CSP restrictiva, nosniff, no-store y textContent evitan ejecución de datos.

Verificación de release histórica (no ejecutada en este cambio): `npm run check`, `npm test`, `npm audit --omit=dev`,
`env -u ROUTER_API_KEY docker compose --env-file /dev/null config --quiet`.
La validación anterior evita cargar `.env` o expandir claves. Tests web usan DOM sintético/VM: no equivalen
a una comprobación visual en navegador real.


### Resultado UI — 2026-10-06 (Router y disponibilidad)

Implementado en fuente; 16 tests DOM/VM de UI/SSE y 2 HTTP loopback dirigidos
pasan (18 total), además de sintaxis de app.js. Colores/límites, estados reales,
fechas UTC en aquella revisión (sustituidas por Madrid abajo), errores ausentes, XSS textual y regresión Start/Stop cubiertos.
Sin validación visual en navegador, consultas live, build/deploy ni suite completa.
Detalle y comandos en IMPLEMENTATION-RESULT.md; resultados anteriores conservados.

### Resultado UI posterior — 2026-10-06 (Madrid y cuentas atrás)

Contrato actual descrito arriba; sustituye presentación UTC histórica.
Validación dirigida DOM/VM y CSS estático, sin navegador ni deploy;
comandos y resultados actuales en la sección final de IMPLEMENTATION-RESULT.md.

### Resultado UI/replay — 2026-10-06
Encabezados numerados/coloreados, logs a ancho disponible y lifecycle sin texto
normal. SSE usa IDs/cursor mínimos backend porque antes no existían IDs estables;
Stop/Start conserva lo mostrado sin duplicar replay. Verificación dirigida:
25/25 UI/SSE, 6/6 backend y 7/7 selección UI bajo TZ New York, sintaxis correcta.
Sin navegador real, APIs live ni Docker/build/deploy. Detalle, archivos y límites
en la última sección de IMPLEMENTATION-RESULT.md.

### Resultado UI/scroll — 2026-10-06
Panel Router centrado (max 72rem), logs fuera del wrapper a ancho disponible,
encabezados `(1) eduard` y seguimiento de logs con pausa/reanudación por scroll.
Verificación dirigida **13/13** DOM/VM/CSS y sintaxis correcta. Sin navegador
real, suite global, audit, Docker, deploy, live ni lectura de secretos.
Evidencia y limitaciones en la sección final de IMPLEMENTATION-RESULT.md.

### Corrección de cuota y recuperación — 2026-10-07 (contrato vigente)
Esta sección sustituye las reglas históricas anteriores de «reset más restrictivo»
y «cuota positiva nunca cancela bloqueo confirmado».

- Semanal agotada (`secondary.usedPercent === 100`): manda **reset semanal**,
  aunque el reset 5h sea posterior. Si el semanal es inválido/vencido, no se
  inventa fecha ni se sustituye por el 5h.
- Semanal disponible (consumo numérico válido <100) y 5h agotado: manda reset 5h.
  Semanal desconocida no equivale a disponible. Resets son Unix segundos.
- Ambas disponibles (consumos numéricos válidos 0..99…, incluido 0 = restante
  100%): no bloquear por sus resets futuros. Evidencia fresca libera la retención
  de cuota y evita recuperación innecesaria, sin borrar contadores ni recuperación
  genérica. Unknown, null, inválido, fallo o caché caducada no liberan una cuota
  confirmada ni crean/extienden un bloqueo nuevo.
- Una cuota retenida vencida sin evidencia positiva de ambas mantiene recuperación
  por sonda única; el mero vencimiento no acredita disponibilidad ni salud.
  Una sonda activa sigue en recuperación hasta terminar: refrescar no la suelta.
  Si llega otro bloqueo, invalida su generación pero conserva la exclusión hasta
  su finalización; su éxito viejo no cierra el bloqueo nuevo.
- Snapshots readonly y selección comparten cálculo efectivo. Refrescar puede mostrar
  cuota liberada sin modificar reservas/generaciones; adquisición/completado
  reconcilian almacenamiento. `/router/status` no hace I/O. Caché, dedupe y timeout
  existentes, sin timers/polling nuevos ni dependencia del navegador.
- `recoveryOrigin`: `generic`, `quota`, `generic_and_quota` o null en closed.
  La UI explica el origen de «En recuperación» y conserva una recuperación real
  por HTTP/red/ECONNRESET aunque ambas cuotas muestren restante 100%.
  Closed significa elegibilidad del breaker, no prueba de salud OAuth.

El síntoma de `(4) sistemes` no se verificó con cuentas/live: el código previo
permitía recuperación persistente por cuota positiva, pero también puede haber
recuperación genérica legítima. Ver informe final para pruebas locales y límites.

### Origen cliente en logs — 2026-10-07
Los logs existentes de petición y eventos correlacionados por `requestId` incluyen
`clientAddress`, también en JSON saneado y visor SSE. Se captura una sola vez de
`socket.remoteAddress` / `socket.remotePort`: **puerto de origen del cliente**,
no el puerto de escucha/destino. IPv4: `192.0.2.1:52341`; IPv6:
`[2001:db8::1]:52341`; `::ffff:192.0.2.1` se normaliza a IPv4.
Se omiten los puertos origen 80/443 y los desconocidos/inválidos; IP desconocida
omite el campo. No se inventan valores. Validación IP específica, máximo 64
caracteres, sin valores libres ni contenido privado; el visor usa `textContent`.

No hay política trusted-proxy configurada: se usa exclusivamente el peer del
socket, ignorando `X-Forwarded-For` y `Forwarded` para logging. **Detrás de un
proxy se verá la IP del proxy y su puerto origen (habitualmente efímero)**, no
necesariamente el usuario final. Forwarding permanece sin cambios.

El panel y `/router/logs` ya son públicos por diseño para quien alcanza el router:
**ahora muestran también IP cliente y, cuando procede, puerto origen**. Los
controles Origin/CSP y la autenticación del proxy API se conservan; Origin no
convierte el panel en privado. No se añaden peticiones/eventos, credenciales,
cuerpos, prompts ni cabeceras sensibles. Se mantienen límites SSE/200 líneas,
dedupe, scroll, cuotas, failover y breaker. Pruebas locales: 48/48 dirigidas,
sintaxis correcta; detalle y límites en IMPLEMENTATION-RESULT.md. Sin deploy.

## Tokens por intento y persistencia — 2026-10-07

Se observa pasivamente **POST /v1/responses y /v1/chat/completions**. No se
modifican peticiones ni `stream_options.include_usage`; bytes, headers end-to-end
 y backpressure de respuesta se conservan. No se guardan prompts, respuestas,
tools, auth, headers, query, modelo ni IP. El log terminal `usage_attempt` sí
conserva `clientAddress` del peer, igual que los logs anteriores. Consola y visor
SSE muestran únicamente métricas escalares saneadas.

Una fila y un evento terminal por intento iniciado, identificados por
`requestId + attempt` (UNIQUE en SQLite). Para estos POST el único log terminal
es **`usage_attempt`**, con los campos de completion (`method`, status, alias,
index, attempt, requestId, clientAddress, durationMs) y las métricas de uso.
Compatibilidad: consumidores que buscaban `request_complete` para estos endpoints
deben consumir `usage_attempt`; no se emiten ambos ni un alias duplicado. Otros
endpoints/métodos mantienen `request_complete`. Los eventos distintos de routing,
retry, breaker y fallo se conservan y **no son filas de consumo**. No hay fila
por chunk ni por upstream omitido; no existen healthchecks de inferencia al arrancar.
La duración canónica se captura una vez al finalizar, desde llegada de petición
(incluye intentos anteriores), y se comparte entre log y fila SQLite. La escritura
se admite antes de emitir el log y no depende de stdout, filtros ni callbacks del
logger: silenciar logs no desactiva el observador ni la persistencia. `method` y
clientAddress son campos del log; la allowlist durable/schema no se amplía.

Campos schemaVersion=1:
- `timestamp`: ISO UTC del terminal; `requestId`, `attempt`, `index`, `alias`,
  `endpoint`, `status` HTTP o null, `durationMs` desde llegada de petición.
- `outcome`: `complete` (transporte HTTP <400, no garantiza generación completa),
  `http_error`, `discarded` (failover sin leer cuerpo), `transport_error` o
  `interrupted` (cancelación/stream cortado).
- `modelStatus`: Responses `completed`, `failed`, `incomplete` o `unknown`,
  independiente del transporte y de la existencia de usage. Chat: unknown.
- `inputTokens`, `outputTokens`, `totalTokens`, `cachedTokens`, `reasoningTokens`:
  enteros safe no negativos recibidos; ausente/inválido = **null**, cero explícito
  = 0. Cached/reasoning son subconjuntos, nunca se suman al total; total ausente
  no se deriva de input+output.
- `usageStatus`: `unknown` o `upstream_reported`. `provenance`: `none`,
  `observation_unavailable`, `responses_upstream_reported` o
  `chat_adapter_reported_zero_ambiguous`. Reportado NO significa contabilidad
  real verificada, cuota ni coste.

Responses JSON usa usage raíz; SSE usa response.usage en response.completed,
response.failed o response.incomplete. Chat JSON usa usage y SSE solo el chunk
final con choices vacío. Terminales idénticos repetidos no se suman; terminales
con métricas distintas vuelven unknown. Un usage válido observado antes de una
cancelación se conserva, con outcome interrupted. Failover descartado queda
unknown: el consumo real total de todos los intentos puede ser mayor que el
usage del resultado entregado. Para contar peticiones, agrupar por requestId;
para resultado final, seleccionar el último intento no discarded por requestId.
No sumar la misma fila de páginas repetidas: deduplicar por id/requestId+attempt.

### Límites de observación
Lexer/parser JSON selectivo incremental UTF-8: descarta strings privados sin
retenerlos; profundidad máxima 64, clave/string seleccionada 256 caracteres,
literal 128 caracteres, trabajo máximo **16 MiB de respuesta por intento**.
SSE admite fragmentación UTF-8, CRLF y data multilínea, sin acumular eventos
completos. Compressed/gzip, charset distinto de UTF-8, JSON malformado, límites
excedidos o fallo del observador producen unknown sin romper forwarding. No se
intenta descomprimir. Si usage llega después de 16 MiB no se observará.

### SQLite sin dependencias y despliegue
Preflight: SQLite integrado evita servicio externo/dependencias y ofrece índice
por fecha y recuperación transaccional; JSONL requeriría escaneos y recuperación
manual de tails. `DatabaseSync` funciona en **worker**, no en el hilo HTTP.
Docker sigue en Node 22, ahora fijado a `22.23.3-bookworm-slim`: node:sqlite está
sin flag desde 22.13, **todavía experimental en Node 22**. No se impone Node 26.
Referencia: https://nodejs.org/docs/latest-v22.x/api/sqlite.html
Tests locales ejecutados con Node 26.7.0; el runtime de esa imagen no se ha probado.

La ruta default se resuelve en código como `<cwd>/data/usage.sqlite` (absoluta).
En local usa el directorio de trabajo; en Docker, `WORKDIR /app` mantiene
exactamente `/app/data/usage.sqlite`, sin definir variables en imagen/Compose.
`USAGE_DB_PATH` sigue disponible como override opcional por compatibilidad;
una ruta relativa se interpreta respecto al directorio de trabajo.
Named volume `router-usage:/app/data` se conserva sin migrar ni borrar datos y sobrevive
restart/recreate; **docker compose down -v elimina el histórico**. La imagen
crea el directorio con propietario node (uid 1000), modo 0700, antes de USER node;
Docker inicializa el volumen nuevo desde ese directorio. Un bind mount/volumen
preexistente requiere permisos de escritura para uid 1000, incluidos WAL/SHM.
No se cambia automáticamente propietario de volúmenes externos.

SQLite schema user_version=1, WAL, synchronous=FULL, busy timeout 1s. Cola máxima
256 operaciones (writes/queries compartidas), timeout 5s; saturación descarta
nuevas escrituras con `usage_storage_drop`, errores con `usage_storage_error`,
solo contadores saneados, nunca path/error libre. El proxy continúa. Health
incluido en consultas: pending/dropped/errors/available (contadores desde arranque).
No hay garantía de entrega exactly-once a disco ante SIGKILL: operaciones no
confirmadas en la cola o intentos activos pueden perderse; filas confirmadas usan
recuperación SQLite. Shutdown normal drena escrituras en orden y cierra worker;
fallo/timeout puede perder pendientes. No monitor ni cron nuevos.

### Consulta pública de solo lectura
`GET /router/usage` conserva el mismo acceso público/Origin/no-store del panel;
ROUTER_API_KEY sigue protegiendo exclusivamente proxy. Cualquier cliente con
acceso al puerto puede consultar alias, timestamps y tokens; logs además exponen
IP/puerto peer. Limitar exposición de red, sin añadir claves locales.

```bash
curl --get 'http://127.0.0.1:10530/router/usage' \
  --data-urlencode 'from=2026-10-07T00:00:00.000Z' \
  --data-urlencode 'to=2026-10-08T00:00:00.000Z' \
  --data-urlencode 'limit=100' \
  --data-urlencode 'account=principal'
```

Rango requerido ISO UTC canónico, **[from,to)** de timestamp terminal, máximo
31 días. limit 1..500 (default 100); account opcional alias; after opcional cursor
id entero (default 0). Claves desconocidas/duplicadas e inválidas → 400. Sin SQL
libre, paths ni payload privado; error almacenamiento → 503 saneado.
Respuesta `{schemaVersion:1,records:[{id,...campos}],nextCursor:null|id,storage:{...}}`.
Repetir mismos filtros con after=nextCursor hasta null. Orden id ascendente;
lectura paginada no es snapshot de escrituras concurrentes. Para agregación diaria usar el resumen SQL descrito abajo, no sumar solo la primera
página. Mantener unknown separado de ceros; cada fila es un intento upstream.
Las consultas trabajan en worker; históricos enormes pueden superar timeout.

Sin TTL, borrados automáticos ni rotación sorpresa: el fichero crece con tráfico.
Operador monitoriza espacio y decide exportación/archivo/retención. Backup mínimo:
parar servicio limpiamente y copiar el volumen completo (DB/WAL/SHM); nunca copiar
solo DB abierta ni eliminar WAL a mano. Restaurar en volumen escribible uid 1000;
no abrir versiones de schema futuras con este código (rechazo explícito).

### Adaptador Chat hermano
El paquete fijado openai-oauth@2.0.0 emite usage final SSE incluso sin include_usage.
Baseline archivado `.inspection/package/dist/chunk-INHW7GRB.js:72–80` convertía
métricas AI SDK ausentes con `?? 0`. El parche durable `openai-oauth-docker/
patch-openai-oauth.mjs` ahora aplica `?? null`, con validación estricta/idempotente
antes de escribir y conservando parches anteriores; archived baseline no editado.
Rebuild del hermano **opcional** para esta corrección; router funciona sin él.
No se puede demostrar desde el wire si una instancia desplegada tiene el parche,
ni si AI SDK ya fabricó un cero: provenance Chat queda deliberadamente ambiguo,
no se promete consumo real. Responses se reenvía por el adaptador sin toUsage.

Construcción/despliegue posteriores por el operador (NO ejecutados aquí):
```bash
cd /home/prova/.openclaw/workspace-oauth-chatgpt/router-openai-oauth
docker compose build
docker compose up -d
# Opcional: rebuild/deploy hermano con su procedimiento, no requerido por router.
```
Conservar configuración/credenciales existentes; comprobar logs de almacenamiento,
consulta y permisos del volumen tras despliegue. Sin suite global, audit, APIs live
ni Docker build/runtime en esta revisión; evidencia dirigida en IMPLEMENTATION-RESULT.md.

### Uso de tokens diario en `/router`
Debajo de logs: gráfico SVG responsive sin librerías/CDN, selectores de cuenta y
inputTokens/outputTokens/totalTokens/cachedTokens/reasoningTokens, fechas inclusivas.
Desde y Hasta se escriben como `dd/mm/aaaa` (por ejemplo `07/10/2026`), con
validación estricta de calendario, bisiestos y rango; campos vacíos conservan los
defaults del servidor. La UI convierte a/desde `YYYY-MM-DD` para la API, sin
calendario nativo dependiente del idioma del navegador. Zona Europe/Madrid,
últimos 30 días por defecto y máximo 31 días incluidos, sin cambios en DST.
Una lectura inicial; los cambios de cuenta/fecha consultan solo el resumen
(no cuotas/logs). Métrica y LLM actualizan localmente, sin otra lectura; peticiones iguales
en vuelo se deduplican y las sustituidas se abortan/ignoran. Sin polling/timers.
Inicialmente consulta `/router/status` para alias configurados, sin llamar upstreams;
combina históricos almacenados del rango (máximo 500, aviso si truncados). Alias
retirados siguen consultables. No URLs/credenciales ni nombres de modelos.

`GET /router/usage/summary?from=2026-10-01&to=2026-10-07&account=principal`
- `from/to`: YYYY-MM-DD inclusivos, años 2000..9998, máximo **31 días calendario**.
  Defaults: hoy Europe/Madrid y 29 días anteriores. Con solo to, from=to-29 días;
  con solo from, to=hoy. Claves desconocidas/duplicadas, SQL/path/cursor/limit → 400.
- Respuesta: schemaVersion, timeZone, from/to, accounts, accountsTruncated, storage,
  days: `{date,attempts,incomplete,metrics:{inputTokens:{sum,known,unknown},…}}`.
  SQLite worker hace GROUP BY por rangos diarios calculados con Intl Madrid,
  incluyendo días DST de 23/25 horas; límites UTC [inicio,siguiente inicio).
  Agrega todas las filas del rango, no páginas ni historial en navegador.
- `sum=null` cuando ninguna fila reporta esa métrica, `known` incluye ceros reales;
  `unknown=attempts-known` por métrica (input/output independientes). Día sin filas:
  attempts=0, sum=null, known=unknown=0; día desconocido: attempts>0, known=0.
  `incomplete`: outcome distinto de complete o modelStatus failed/incomplete;
  es un contador solapado, no otra suma. Cuenta por intento requestId+attempt único;
  failover legítimo cuenta cada intento pero duplicados de la misma fila no.
- Cached/reasoning son subconjuntos; sumas upstream-reportadas, no cuota, precio ni
  contabilidad exacta. Chat conserva su ambigüedad de procedencia. Huecos sin datos
  y desconocidos tienen símbolos distintos; parciales usan punto hueco. Solo se
  conectan días adyacentes completamente conocidos. Fecha/consumo/counts accesibles
  por hover/foco/toque, etiquetas aria y lista textual diaria solo para lectores
  de pantalla (sin sección desplegable visible). El total sigue identificado como
  suma reportada; los contadores se conservan en los detalles de cada día, no en
  una línea global visible. Los errores y avisos de datos parciales siguen visibles.
- Acceso público, Origin/CSP/no-store idénticos al panel. DB falla → 503 saneado,
  aviso recuperable con Refrescar; resto del panel sigue funcionando. Sumas
  fuera del entero seguro fallan sin redondear silenciosamente. Sin migración DB.
  Resultado acotado a 31 días y 500 alias; coste SQL depende de filas del rango,
  cola/timeout existentes 256 operaciones/5s. No TTL ni garantía snapshot entre
  SELECTs de alias y días; no implica cobertura de intentos perdidos/no persistidos.

Verificación de esta ampliación: 62 tests dirigidos HTTP loopback/SQLite/DOM-VM,
no suite global, audit, APIs reales ni Docker build/deploy. Ver IMPLEMENTATION-RESULT.

### Simulación de precio LLM en Uso de tokens

El panel anteriormente solo mostraba cantidades: las métricas agregadas ya estaban
 disponibles, pero no había catálogo de tarifas ni conversión monetaria. Ahora el
 campo único **combobox buscable** filtra por nombre/proveedor, con lista acotada
 y selección por ratón/touch o flechas + Enter. Escape, Tab, desenfoque o click
 fuera cierran sin cambiar la selección; borrar la búsqueda no la elimina
 (elige «Sin simulación» para hacerlo). No se añaden librerías ni dependencias:
 el patrón previo de dos controles no cubre el campo único solicitado y se usa
 DOM propio bajo `connect-src 'self'`. La documentación de tarifas y límites queda
 aquí, sin nota larga visible; los fallos muestran un aviso breve con reintento.
 Un rango/día sin observaciones muestra «Sin datos» sin desglose ni precio;
 ceros reportados y datos parciales mantienen sus cifras. Selección persistida
 en `localStorage` (`router.pricing.model`, proveedor + ID); por defecto no hay
 simulación. El modelo elegido **no filtra el modelo real ni modifica inferencia**.
 Las cifras de cuenta/rango/día siguen siendo los intentos reportados existentes,
 no una factura, ni una verificación de consumo OAuth.

`GET /router/pricing` es público, solo lectura, sin parámetros y con el mismo
 guard Origin/Sec-Fetch-Site del panel. Solo esta ruta activa las consultas externas:
 no hay tráfico de catálogo/FX al arrancar ni por cada render/selector. No envía
 cuentas, tokens, cuotas, textos ni headers del cliente. CSP y autenticación del
 proxy se conservan. El frontend carga el endpoint una vez; el único botón **Refrescar** consulta uso
 y catálogo/FX, respetando los TTL backend, sin forzar ni eludir caché. Escribir
 o seleccionar un LLM no inicia ninguna petición.

- Catálogo: <https://api.litellm.ai/model_catalog?page=1&page_size=500>;
  contrato <https://api.litellm.ai/docs#/> / `openapi.json`. Sigue `has_more` y
  valida páginas y conteo; excluye embeddings, imagen, audio, etc. Solo `chat` y
  `completion` con alguna tarifa input/output numérica finita >= 0. Identidad por
  proveedor/ID; dedupe exacto, conflictos rechazan la carga. Ausente/inválido es
  `null`, nunca cero. Publica únicamente nombres/modo y cuatro tarifas permitidas.
- Las tarifas LiteLLM son **USD por token**, según
  <https://docs.litellm.ai/docs/completion/token_usage>. Caché utiliza
  `cache_read_input_token_cost`; razonamiento utiliza
  `output_cost_per_reasoning_token` cuando existe.
- FX gratuito sin keys: Frankfurter v2, proveedor **BCE explícito**, no promedio:
  <https://api.frankfurter.dev/v2/providers/ecb/rate/USD/EUR>;
  documentación <https://frankfurter.dev/>. Se valida base/quote, tasa positiva y
  fecha calendario, no futura ni de más de 7 días. Se muestra fuente/fecha; el
  cambio actual se aplica a todo el rango, **no cambio histórico por día**.
  Si falla/expira, se muestra **USD**, nunca euros por paridad supuesta.
- Caché en memoria por proceso: catálogo 24 h, FX 6 h, errores 60 s;
  single-flight independiente. Timeout de 20 s para cada carga completa,
  redirects prohibidos, JSON acotado a 2 MiB/página y 16 KiB FX, máximo 30 páginas
  de 500. Carga paginada incompleta no se presenta como catálogo completo.
  Ante HTTP 429 no se reintenta en bucle; se aplica cooldown. Reiniciar elimina
  caché; varios procesos tienen cachés independientes.

Semántica: los campos capturados por el observador Responses/Chat son detalles
 de entrada/salida, **subconjuntos**, no métricas adicionales. El cálculo es lineal:
 `(input - cached) × inputRate + cached × cacheRate +
 (output - reasoning) × outputRate + reasoning × reasoningRate`.
 Los importes inline Entrada/Salida representan componentes exclusivos; los
 números siguen mostrando los totales inclusivos reportados y los aria-labels
 explican los subconjuntos. Sin tarifa reasoning propia se usa outputRate y el
 total factura output una sola vez; incluso si reasoning es desconocido puede
 estimarse todo output a esa tarifa (el detalle reasoning continúa N/D).
 Se usan sumas numéricas con `known > 0` aunque `unknown > 0`; `sum: null`
 nunca equivale a cero. SQLite/worker conserva `{sum, known, unknown}` por métrica.
 Si los subconjuntos conocidos son <= sus padres conocidos, se restan para formar
 componentes exclusivos; cobertura parcial/desigual no prueba correspondencia
 fila a fila y marca el importe `≈ … · parcial`, no exacto ni mínimo garantizado.
 Sin detalle conocido se simula el padre a su tarifa; si sólo existe el subconjunto,
 se estima éste. Un subconjunto mayor que el padre se excluye de la composición
 y se marca incertidumbre, sin sumar dos veces. El total suma únicamente importes
 computables de esos componentes; tarifas faltantes no borran los demás importes
 y marcan el total parcial. `N/D` sólo cuando no hay importe computable.
 No se usa `totalTokens × tarifa`; puede diferir de input + output.
 Cero reportado cuesta cero aunque falte tarifa; rango vacío sigue «Sin datos».
 Importes pequeños usan hasta 6 cifras significativas. FX ausente conserva USD.

Limitaciones: tarifas comunitarias actuales/base, sin reconstrucción histórica,
 descuentos, impuestos, batch/service tier, cache creation, umbrales de contexto,
 modalidades de imagen/audio ni precios negociados. El agregado no distingue esos
 extras ni aporta correlación fila a fila para parciales: su composición es
 aproximada, no una factura ni un límite inferior. No hay nuevo tokenizer ni verificación de que el
 modelo elegido corresponda al modelo real. Las tarifas propias reasoning del
 catálogo se interpretan como USD por token del subconjunto; ausencia usa la
 semántica output de OpenAI, no se inventa una tarifa adicional.

Verificación dirigida: `node --test test/pricing.test.mjs
 test/usage-chart.test.mjs test/usage-summary.test.mjs test/web.test.mjs` y `npm run check`.
 Incluye regresión integrada JSON Responses/Chat → observador → SQLite worker
 → HTTP summary/catalog → DOM: selección pointer y teclado muestra precios
 calculables del rango/día sin lecturas de uso adicionales, con subconjuntos completos
 o ausentes, USD fallback y assets no-store/CSP/orden de scripts.
 La regresión REAL mezcla una fila con métricas y otra sin métricas en SQLite:
 `{sum,known:1,unknown:1}` para input 2.880.607, output 17.767, total 2.898.374,
 caché 575.232 y reasoning 1.397; HTTP → DOM prueba ratón/teclado y precios
 numéricos parciales en rango/día, reasoning a tarifa output y FX fallback.
 Causa reproducida anterior: `complete()` exigía `unknown === 0` y devolvía todos
 los importes null aun con modelo/tarifas válidos. GET público verificó catálogo
 paginado y tarifas OpenAI; sin nuevas tarifas predeterminadas en runtime.
 Incluye mocks HTTP/fetch para paginación, errores, límites, TTL, FX, privacidad,
 Origin, precios sin doble conteo, cero/null, pequeñas cantidades y DOM para
 búsqueda, selección por teclado/click/touch, Escape/Tab/click fuera, búsqueda
 vacía sin selección automática, ARIA, persistencia, estados vacíos/cero/parcial,
 ausencia de nota larga, inline rango/día, cambio de cuenta sin filtro
 model, dedupe/abort/JSON tardío. Mantiene el espacio reservado y no mueve scroll
 ni foco; cambios de precio no reconstruyen el SVG enfocado. Evidencia DOM/CSS,
 no medición visual ni validación con navegador real.

Comprobación pública de desarrollo (2026-10-08): el lector recuperó 3264 entradas
 LLM token-priced tras consumir el catálogo completo (4503 entradas de todos los
 modos). Frankfurter/BCE devolvió 0.89397 EUR por USD con referencia 2026-10-08.
 Estos valores son evidencia puntual, no constantes ni tarifas hardcodeadas.
 No se ejecutaron builds Docker, despliegues, instalaciones, suites globales,
 auditorías de dependencias ni llamadas de inferencia/producción.

### Correcciones de auditoría global — 2026-10-09

- El transporte asigna pathname/query sobre la URL configurada: un pathname
  normalizado que empiece por `//` no puede sustituir la autoridad del upstream.
  La autenticación se verifica antes de forwarding; targets absolutos ajenos y
  network-path targets siguen rechazándose.
- El contador de resets sólo acepta `ECONNRESET` atribuible. Otros `clientError`
  del parser HTTP abortan la petición pero no penalizan al upstream. Un error
  upstream de streaming conserva su causa antes del teardown: timeout cuenta
  como fallo genérico, sin retry después de enviar cabeceras. Errores inducidos
  por abort downstream no se reclasifican como fallos upstream.
- Un error fatal del listener cierra el hub y el worker SQLite y termina con
  código no cero; no queda un proceso sin listener sostenido por el worker.
- La UI valida también sumas/counts del rango completo: overflow de enteros safe
  presenta error recuperable y limpia datos, nunca muestra un total redondeado.
  Métricas desconocidas siguen desconocidas, no se convierten en cero.
- Docker ya no declara variables `STARTUP_HEALTHCHECK_*` retiradas. Se conservan
  los defaults runtime, volumen durable y usuario no privilegiado.

Regresiones con HTTP loopback, proceso aislado/SQLite temporal y DOM/VM;
no requieren cuentas ni llamadas de inferencia. La validación local no sustituye
la comprobación posterior del runtime Docker, integración ni navegador real.
