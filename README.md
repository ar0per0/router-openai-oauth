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
      UPSTREAMS: "principal=http://192.168.1.15:10531" # Upstreams en orden de prioridad; separa varias URLs con "|".
      UPSTREAM_TIMEOUT_MS: 180000 # Tiempo máximo de espera por inactividad de cada upstream, en milisegundos.
      STARTUP_HEALTHCHECK_TIMEOUT_MS: 5000 # Tiempo máximo de la comprobación inicial de cada upstream, en milisegundos.
      UPSTREAM_FAILURE_THRESHOLD: 3 # Número de errores consecutivos antes de desactivar temporalmente un upstream.
      UPSTREAM_COOLDOWN: "10m" # Tiempo durante el que se omite un upstream desactivado.
      MAX_REQUEST_BODY_BYTES: 33554432 # Tamaño máximo permitido del cuerpo de una petición, en bytes.
      RETRY_STATUS_CODES: "401,403,408,429,500-599" # Estados HTTP que hacen que el router pruebe el siguiente upstream.
      ROUTER_API_KEY: "" # Clave Bearer opcional para proteger el acceso al router; vacía significa sin autenticación.
    ports:
      - "10530:10530"
```
---

## Política de failover

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
[router-openai-oauth] [principal] WARN ... upstream_skipped {"alias":"principal","remainingMs":...}
[router-openai-oauth] [principal] INFO ... upstream_circuit_half_open {"alias":"principal",...}
[router-openai-oauth] [principal] INFO ... upstream_circuit_closed {"alias":"principal",...}
```

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
| `UPSTREAMS` | `http://127.0.0.1:10531` | Upstreams ordenados, con alias opcional y separados mediante `\|`. |
| `UPSTREAM_TIMEOUT_MS` | `180000` | Timeout por inactividad de cada intento. |
| `STARTUP_HEALTHCHECK_TIMEOUT_MS` | `5000` | Tiempo máximo de la prueba inicial de cada upstream. |
| `UPSTREAM_FAILURE_THRESHOLD` | `3` | Errores consecutivos antes de omitir un upstream. |
| `UPSTREAM_COOLDOWN` | `10m` | Periodo durante el que se omite; acepta `ms`, `s`, `m`, `h` o `d`. |
| `MAX_REQUEST_BODY_BYTES` | `33554432` | Tamaño máximo del cuerpo que puede reintentarse. |
| `RETRY_STATUS_CODES` | `401,403,408,429,500-599` | Estados que activan el siguiente upstream. |
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

El endpoint local de estado no consume cuota ni comprueba los modelos:

```bash
curl http://127.0.0.1:10530/health
```

Respuesta:

```json
{"status":"ok","upstreams":2}
```

Las respuestas proxificadas incluyen:

- `x-router-request-id`: identificador para correlacionar logs;
- `x-router-upstream-index`: upstream que respondió, comenzando por `1`;
- `x-router-upstream-alias`: alias del upstream que respondió;
- `x-router-attempts`: número de intentos realizados.

Los logs nunca incluyen cuerpos, prompts, respuestas ni credenciales.

Al arrancar se consulta `/health` en todos los upstreams, en paralelo y sin
consumir cuota de modelo. El resultado se registra individualmente y después
se escribe un resumen. Un upstream caído no impide que el router arranque,
porque puede recuperarse posteriormente.

Ejemplo:

```text
[router-openai-oauth] INFO ... upstream_healthcheck_ok {"index":1,"alias":"principal","upstream":"http://192.168.1.15:10531","status":200,"healthy":true,"durationMs":18}
[router-openai-oauth] INFO ... upstream_healthcheck_complete {"healthy":1,"total":1}
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
