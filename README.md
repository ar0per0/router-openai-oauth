Proyecto construido con OpenClaw + ChatGPT Codex.

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
      STARTUP_HEALTHCHECK_TIMEOUT_MS: 30000# Tiempo máximo de la comprobación inicial de cada upstream, en milisegundos.
      STARTUP_HEALTHCHECK_MODEL: "gpt-6.1-sol" # Modelo de la comprobación; vacío selecciona el primero de /v1/models.
      UPSTREAM_FAILURE_THRESHOLD: 3 # Número de errores consecutivos antes de desactivar temporalmente un upstream.
      CLIENT_ERROR_FAILURE_THRESHOLD: 5 # Durante el diagnóstico, devuelve el error observado sin probar el siguiente upstream.
      UPSTREAM_COOLDOWN: "10m" # Tiempo durante el que se omite un upstream desactivado.
      MAX_REQUEST_BODY_BYTES: 33554432 # Tamaño máximo permitido del cuerpo de una petición, en bytes.
      RETRY_STATUS_CODES: "401,403,408,429,500-599" # Estados HTTP que hacen que el router pruebe el siguiente upstream.
      ROUTER_API_KEY: "" # Clave Bearer opcional para proteger el acceso al router; vacía significa sin autenticación.
      STARTUP_HEALTHCHECK_ENABLED: true # Activa o desactiva las pruebas reales de los upstreams antes de escuchar peticiones.
      RUNTIME_FAILOVER: true # Durante el diagnóstico, devuelve el error observado sin probar el siguiente upstream.
    ports:
      - "10530:10530"
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
[router-openai-oauth] [principal] [4/5] WARN 2026-10-03 14:26:25 upstream_client_error {...}
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
y el destino se omite durante `UPSTREAM_COOLDOWN`, cuyo valor predeterminado es
`10m`. Un éxito reinicia el contador.

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
| `UPSTREAM_TIMEOUT_MS` | `180000` | Timeout por inactividad de cada intento. |
| `STARTUP_HEALTHCHECK_ENABLED` | `true` | Si es `true`, valida los upstreams antes de escuchar; si es `false`, omite todas las pruebas iniciales. |
| `STARTUP_HEALTHCHECK_TIMEOUT_MS` | `30000` | Tiempo máximo de cada intento de prueba real de modelo. |
| `STARTUP_HEALTHCHECK_MODEL` | vacío | Modelo usado en la prueba inicial; vacío selecciona el primer modelo que no sea de imagen. |
| `UPSTREAM_FAILURE_THRESHOLD` | `3` | Intentos máximos al arrancar y errores consecutivos antes de omitir un upstream. |
| `CLIENT_ERROR_FAILURE_THRESHOLD` | `5` | Errores `ECONNRESET` consecutivos, entrantes o salientes, que abren el circuito del upstream afectado. Se contabilizan aparte de `UPSTREAM_FAILURE_THRESHOLD`. |
| `RUNTIME_FAILOVER` | `false` | Controla el failover para HTTP, timeouts y otros transportes. Un `ECONNRESET` siempre termina la petición actual y cambia de upstream únicamente en una petición posterior al alcanzar su umbral. |
| `UPSTREAM_COOLDOWN` | `10m` | Periodo durante el que se omite; acepta `ms`, `s`, `m`, `h` o `d`. |
| `MAX_REQUEST_BODY_BYTES` | `33554432` | Tamaño máximo del cuerpo que puede reintentarse. |
| `RETRY_STATUS_CODES` | `401,403,408,429,500-599` | Estados contabilizados como fallo; activan el siguiente upstream solo con `RUNTIME_FAILOVER=true`. |
| `ROUTER_API_KEY` | vacío | Bearer token opcional para proteger el router. |

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
aplica la misma autenticación Bearer que las rutas proxificadas y no muestra las
URLs ni las credenciales de los upstreams:

```bash
curl -H 'Authorization: Bearer TU_ROUTER_API_KEY' \
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
`UPSTREAM_COOLDOWN`. Como la conexión del cliente que produjo el `ECONNRESET`
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

Antes de empezar a escuchar peticiones, el router valida todos los upstreams
en paralelo. Cada upstream se prueba secuencialmente hasta que responde bien o
agota `UPSTREAM_FAILURE_THRESHOLD` intentos reales de modelo. Si
`STARTUP_HEALTHCHECK_MODEL` está vacío, consulta primero `/v1/models` y elige el
primer modelo que no sea de imagen. Después envía a `/v1/chat/completions` una
operación aritmética aleatoria y exige una respuesta exactamente igual a `OK`.
Esta prueba comprueba conectividad, autenticación, cuota y funcionamiento del
modelo. Cada intento consume una petición de modelo.

Un upstream se marca como saludable en cuanto supera un intento completo. Si
falla todos los intentos por timeout, cuota, autenticación, error HTTP o
respuesta inesperada, empieza con el circuito abierto durante
`UPSTREAM_COOLDOWN`. El servidor no empieza a escuchar hasta terminar la
validación de todos los upstreams.

Los reintentos intermedios no generan una línea de log. Para cada upstream se
muestra únicamente `upstream_healthcheck_ok` o `upstream_healthcheck_failed`.
Cuando un resultado fallido abre el circuito inicial también se muestra
`upstream_initially_disabled`, con el umbral, cooldown y `disabledUntil`.

Para arrancar inmediatamente sin consumir peticiones de modelo ni comprobar
los upstreams, configura:

```yaml
STARTUP_HEALTHCHECK_ENABLED: false
```

En ese caso se registra `upstream_healthcheck_skipped` y todos los circuitos
empiezan cerrados. Sus estados se determinarán después a partir de las
peticiones reales.

Ejemplo:

```text
[router-openai-oauth] [principal] INFO 2026-10-03 08:04:21 upstream_healthcheck_ok {"index":1,"alias":"principal","upstream":"http://192.168.1.15:10531","model":"gpt-5.6-luna","status":200,"healthy":true,"response":"OK","durationMs":4218}
[router-openai-oauth] INFO 2026-10-03 08:04:21 upstream_healthcheck_complete {"healthy":1,"total":1}
```

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
