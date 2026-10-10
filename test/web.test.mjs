import test from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFile } from "node:fs/promises"

const source = await readFile(new URL("../src/web/app.js", import.meta.url), "utf8")
const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8")
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
const deferred = () => {
	let resolve, reject
	const promise = new Promise((yes, no) => { resolve = yes; reject = no })
	return { promise, resolve, reject }
}
class Element {
	constructor() { this.children = []; this.listeners = {}; this.value = ""; this.disabled = false; this.text = ""; this.clientHeight = 60; this.top = 0; this.scrollLeft = 0 }
	get scrollHeight() { return Math.max(this.clientHeight, this.text ? this.text.split("\n").length * 20 : 0) }
	get scrollTop() { return this.top }
	set scrollTop(value) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) }
	set textContent(text) { this.text = String(text); this.children = [] }
	get textContent() { return this.text + this.children.map((c) => c.textContent).join("\n") }
	set innerHTML(_) { throw new Error("Unsafe HTML") }
	appendChild(c) { this.children.push(c); return c }
	replaceChildren(...children) { this.text = ""; this.children = children }
	addEventListener(name, callback) { this.listeners[name] = callback }
	removeEventListener(name, callback) { if (this.listeners[name] === callback) delete this.listeners[name] }
	fire(name = "click") { return this.listeners[name]?.() }
}
const fixedNow = Date.parse("2026-10-06T12:00:00Z")
const harness = (fetcher = () => { throw new Error("unexpected request") }, now = fixedNow, testStartup = false) => {
	class Clock extends Date { static now() { return typeof now === "function" ? now() : now } }
	const ids = ["bearer", "refresh", "accounts", "account-status", "upstream-summary", "log-status", "start", "stop", "logs"]
	const nodes = Object.fromEntries(ids.map((id) => [id, new Element()]))
	const events = {}, calls = [], startupCalls = []; let initializing = true
	const forbidden = () => { throw new Error("forbidden timer/storage/log API") }
	const context = {
		document: { getElementById: (id) => nodes[id], createElement: () => new Element() },
		window: { addEventListener: (name, fn) => { events[name] = fn } },
		fetch: (url, options) => {
 if (initializing && !testStartup) { startupCalls.push({url, options}); return jsonResponse({accounts:[]}) }
 calls.push({ url, options }); return fetcher(url, options)
 },
		AbortController, TextDecoder, Date: Clock, Intl,
		setInterval: forbidden, setTimeout: forbidden, console: { log: forbidden, error: forbidden, warn: forbidden },
	}
	for (const key of ["localStorage", "sessionStorage", "indexedDB", "location", "EventSource"]) {
		Object.defineProperty(context, key, { get: forbidden })
		Object.defineProperty(context.window, key, { get: forbidden })
	}
	vm.runInNewContext(source, context)
	initializing = false
 return { nodes, events, calls, startupCalls }
}
const stream = () => {
	const queue = [], waiting = []
	let cancelled = 0, released = 0, bodyCancelled = 0
	const reader = {
		read: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject })),
		cancel: async () => { cancelled++; while (waiting.length) waiting.shift().resolve({ done: true }) },
		releaseLock: () => { released++ },
	}
	const send = (item) => waiting.length ? waiting.shift().resolve(item) : queue.push(item)
	return {
		response: { ok: true, headers: { get: () => "text/event-stream; charset=utf-8" }, body: { getReader: () => reader, cancel: async () => { bodyCancelled++ } } },
		push: (text) => send({ done: false, value: new TextEncoder().encode(text) }),
		bytes: (bytes) => send({ done: false, value: bytes }),
		end: () => send({ done: true }),
		fail: () => { assert.ok(waiting.length); waiting.shift().reject(new Error("private error body")) },
		get cancelled() { return cancelled }, get released() { return released }, get bodyCancelled() { return bodyCancelled },
	}
}
const authorized = (h) => { h.nodes.bearer.value = "secret-only-in-memory" }
const jsonResponse = (data) => ({ ok: true, json: async () => data })

test("HTML external assets and restrictive CSP, no inline code or credential persistence", () => {
	assert.match(html, /src="\/router\/app\.js" defer/)
	assert.match(html, /href="\/router\/style\.css"/)
	assert.doesNotMatch(html, /type="password"|id="bearer"/)
	assert.match(html, /default-src 'none';script-src 'self';style-src 'self';connect-src 'self';base-uri 'none';frame-ancestors 'none';form-action 'none'/)
	assert.match(html, /<title>Router<\/title>/)
	assert.match(html, /<h1>Router<\/h1>/)
	assert.doesNotMatch(html, /Estado de upstreams, disponibilidad y logs\.|Todas las fechas en UTC/)
	assert.doesNotMatch(html, /Panel local sin contraseña|cuotas y los circuitos son independientes/)
	assert.doesNotMatch(html, /<style\b|\sstyle=|\son\w+=|<script[^>]*>\s*[^<\s]/i)
	assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\.|setInterval|setTimeout|EventSource/)
})

test("startup refresh exactly once including failure, no polling or auto SSE; manual retry", async () => {
 for (const failure of [false,true]) {
  const h = harness(() => failure ? Promise.reject(new Error("private")) : jsonResponse({ accounts: [], fetchedAt: "now" }), fixedNow, true)
  await tick(); assert.equal(h.calls.length,1)
  assert.equal(h.calls[0].url,"/router/accounts/rate-limits?refresh=1")
  assert.equal(h.calls[0].options.headers,undefined)
  assert.equal(h.calls[0].options.credentials,"omit")
  assert.equal(h.nodes.refresh.disabled,false)
  if(failure) assert.match(h.nodes["account-status"].textContent,/No se pudieron/)
  await tick(); h.events.pageshow(); await tick(); assert.equal(h.calls.length,1)
  await h.nodes.refresh.fire(); assert.equal(h.calls.length,2)
  assert.ok(h.calls.every(c=>c.url.includes("rate-limits")))
 }
})

test("quota presentation: available windows and concise real circuit fields", async () => {
	const window = { usedPercent: 33, windowDurationMins: 17, resetsAt: 1791300394 }
	const h = harness(() => jsonResponse({ fetchedAt: "stamp", accounts: [
		{ alias: "<img onerror=alert(1)>", circuit: { state: "open", remainingMs: 1200, disabledUntil: "2026-10-06T20:56:45.123Z", failures: 2, clientErrors: 3, probeInFlight: false }, error: null, rateLimits: { rateLimits: { limitId: "global", limitName: "All", primary: window, secondary: null, credits: { hasCredits: true, unlimited: false, balance: "12.34" }, planType: "pro", tertiary: { ...window, windowDurationMins: 99 }, windows: { extra: { ...window, windowDurationMins: 20160 }, nullable: null } }, rateLimitsByLimitId: { alpha: { limitId: "A", primary: null, secondary: window, credits: null }, beta: null } } },
		{ alias: "empty", circuit: { state: "closed", remainingMs: 0 }, error: "<script>bad</script>", rateLimits: null },
		{ alias: "probe", circuit: { state: "half_open", probeInFlight: true }, rateLimits: { rateLimits: { primary: { usedPercent: null, windowDurationMins: null, resetsAt: null } } } },
	] }))
	authorized(h); await h.nodes.refresh.fire()
	const text = h.nodes.accounts.textContent
	for (const expected of ["<img onerror=alert(1)>", "<script>bad</script>", "(1) <img onerror=alert(1)>", "(2) empty", "En recuperación", "Errores cliente: 3", "Sonda en curso", "Restante 67%\n · Se restablece en 3h 26m", "Restante desconocido\n · Se restablece en desconocido"]) assert.ok(text.includes(expected), expected);
	assert.doesNotMatch(text, /Límite general|Error: ninguno|Cooldown|Fallos|Deshabilitado hasta|false|Probe|unknown|Duración|Unix|1791300394|15:26:|\.123|ID:|Nombre:|Plan:|Créditos|saldo|por ID|tertiary|windows\.|normalModelSlug|1970|Consumido:/);
	for (const card of h.nodes.accounts.children) {
		assert.equal(card.children.filter((n) => n.textContent === "Límite 5h").length, 1);
		assert.equal(card.children.filter((n) => n.textContent === "Límite semanal").length, 1);
	}
	assert.equal(h.nodes["upstream-summary"].textContent, "1 activos\n · 1 deshabilitados\n · 1 en recuperación");
	assert.deepEqual(h.nodes["upstream-summary"].children.map(n => n.className), ["health-green", "health-red", "health-yellow"]);
	assert.doesNotMatch(html, /UTC|upstreams/);
	assert.equal(h.nodes.accounts.children.length, 3)
})

test("quota relative date and invalid/null values never become zero or epoch", async () => {
	for (const resetsAt of [1791300394, null, undefined, "1791300394", NaN, Infinity, 1e20]) {
		const h = harness(() => jsonResponse({ accounts: [{ rateLimits: { rateLimits: { primary: { usedPercent: 33, resetsAt }, secondary: { usedPercent: 0, resetsAt: null } } } }] }));
		await h.nodes.refresh.fire();
		const lines = h.nodes.accounts.children[0].children.map((n) => n.textContent).filter((s) => s.includes("Se restablece en"));
		assert.equal(lines[0], `Restante 67%\n · Se restablece en ${resetsAt === 1791300394 ? "3h 26m" : "desconocido"}`);
		assert.equal(lines[1], "Restante 100%\n · Se restablece en desconocido");
	}
});

test("refresh failures do not expose response/error bodies and stale refresh cannot win", async () => {
	const old = deferred(), next = deferred()
	let count = 0
	const h = harness(() => ++count === 1 ? old.promise : next.promise)
	authorized(h)
	const a = h.nodes.refresh.fire(), b = h.nodes.refresh.fire()
	assert.ok(h.calls[0].options.signal.aborted)
	next.resolve(jsonResponse({ accounts: [], fetchedAt: "2026-10-06T20:56:45.123Z" })); await b
	old.resolve(jsonResponse({ accounts: [], fetchedAt: "2026-10-05T10:00:00Z" })); await a
	assert.match(h.nodes["account-status"].textContent, /06-10-2026 22:56/)
	assert.equal(h.nodes.refresh.disabled, false)
	const broken = harness(() => ({ ok: false, json: () => { throw new Error("SECRET") } }))
	authorized(broken); await broken.nodes.refresh.fire()
	assert.match(broken.nodes["account-status"].textContent, /No se pudieron/)
	assert.doesNotMatch(broken.nodes["account-status"].textContent, /SECRET/)
})

test("manual SSE start, duplicate start, metadata allowlist, fragmented UTF8/CRLF, cap and XSS", async () => {
	const s = stream(), h = harness(() => s.response)
	authorized(h)
	const run = h.nodes.start.fire(); await tick()
	await h.nodes.start.fire(); assert.equal(h.calls.length, 1)
	assert.equal(h.calls[0].url, "/router/logs")
	assert.equal(h.calls[0].options.headers, undefined)
	assert.equal(h.nodes["log-status"].textContent, "")
	const event = 'data: {"event":"<script>é</script>",\r\ndata: "details":{"alias":"uno","status":200,"headers":"SECRET","body":"SECRET"},"token":"SECRET","message":"SECRET"}\r\n\r\n'
	const bytes = new TextEncoder().encode(event)
	for (const byte of bytes) { s.bytes(new Uint8Array([byte])); await tick() }
	assert.match(h.nodes.logs.textContent, /<script>é<\/script>/)
	assert.match(h.nodes.logs.textContent, /"alias":"uno"/)
	assert.doesNotMatch(h.nodes.logs.textContent, /SECRET|details|headers|body|token|message/)
	s.push(': heartbeat\n\ndata: not JSON\n\ndata: {"payload":"drop"}\n\n')
	await tick(); assert.equal(h.nodes.logs.textContent.split("\n").length, 1)
	for (let i = 0; i < 205; i++) { s.push(`data: {"event":"event-${i}"}\n\n`); await tick() }
	await tick(); await tick()
	assert.equal(h.nodes.logs.textContent.split("\n").length, 200)
	assert.match(h.nodes.logs.textContent.split("\n")[0], /event-5/)
	assert.match(h.nodes.logs.textContent.split("\n").at(-1), /event-204/)
	h.nodes.stop.fire(); await run
	assert.equal(s.cancelled, 1); assert.equal(s.released, 1)
	assert.ok(h.calls[0].options.signal.aborted)
	assert.equal(h.nodes["log-status"].textContent, "")
	assert.equal(h.nodes.start.disabled, false); assert.equal(h.nodes.stop.disabled, true)
	await tick(); assert.equal(h.calls.length, 1)
})

test("EOF and read error clean up, no reconnect, incomplete event ignored", async () => {
	for (const failure of [false, true]) {
		const s = stream(), h = harness(() => s.response); authorized(h)
		const run = h.nodes.start.fire(); await tick()
		s.push('data: {"event":"incomplete"}'); await tick()
		if (failure) s.fail(); else s.end()
		await run
		assert.equal(h.nodes.logs.textContent, "")
		if (failure) assert.match(h.nodes["log-status"].textContent, /Error de conexión/); else assert.equal(h.nodes["log-status"].textContent, "")
		assert.equal(s.cancelled, 1); assert.equal(s.released, 1)
		assert.equal(h.nodes.start.disabled, false)
		await tick(); assert.equal(h.calls.length, 1)
	}
})

test("Stop before fetch resolves cancels late body without corrupting newer connection", async () => {
	const pending = deferred(), stale = stream(), fresh = stream()
	let count = 0
	const h = harness(() => ++count === 1 ? pending.promise : fresh.response); authorized(h)
	const old = h.nodes.start.fire(); h.nodes.stop.fire()
	const current = h.nodes.start.fire(); await tick()
	pending.resolve(stale.response); await old
	assert.equal(stale.bodyCancelled, 1)
	assert.equal(stale.cancelled, 0)
	assert.equal(h.nodes["log-status"].textContent, "")
	assert.equal(h.nodes.start.disabled, true)
	fresh.push('data: {"event":"current"}\n\n'); await tick()
	assert.match(h.nodes.logs.textContent, /current/)
	h.nodes.stop.fire(); await current
})

test("pending old read after Stop/Start cannot append or change new viewer state", async () => {
	const lateRead = deferred(), newStream = stream()
	let cancels = 0, releases = 0, calls = 0
	const oldResponse = { ok: true, headers: { get: () => "text/event-stream" }, body: { getReader: () => ({ read: () => lateRead.promise, cancel: async () => { cancels++ }, releaseLock: () => { releases++ } }) } }
	const h = harness(() => ++calls === 1 ? oldResponse : newStream.response); authorized(h)
	const old = h.nodes.start.fire(); await tick(); h.nodes.stop.fire()
	const current = h.nodes.start.fire(); await tick()
	lateRead.resolve({ done: false, value: new TextEncoder().encode('data: {"event":"stale"}\n\n') })
	await old
	assert.equal(cancels, 1); assert.equal(releases, 1)
	assert.equal(h.nodes.logs.textContent, "")
	assert.equal(h.nodes["log-status"].textContent, "")
	h.nodes.stop.fire(); await current
})

test("pagehide clears data and aborts both independent connections", async () => {
	const pending = deferred(), s = stream()
	const h = harness((url) => url.includes("rate-limits") ? pending.promise : s.response); authorized(h)
	const quota = h.nodes.refresh.fire(), run = h.nodes.start.fire(); await tick()
	s.push('data: {"event":"visible"}\n\n'); await tick()
	assert.match(h.nodes.logs.textContent, /visible/)
	h.events.pagehide(); await run
	assert.ok(h.calls.every((c) => c.options.signal.aborted))
	assert.equal(h.nodes.logs.textContent, "")
	pending.resolve(jsonResponse({ accounts: [], fetchedAt: "stale" })); await quota
	assert.doesNotMatch(h.nodes["account-status"].textContent, /stale/)
	h.events.pagehide()
	assert.equal(h.nodes.accounts.textContent, "")
})

test("bad SSE response cleans body; oversize event is ignored and next valid frame survives", async () => {
	for (const bad of [{ ok: false, type: "text/event-stream" }, { ok: true, type: "application/json" }]) {
		const s = stream(); s.response.ok = bad.ok; s.response.headers.get = () => bad.type
		const h = harness(() => s.response); authorized(h); await h.nodes.start.fire()
		assert.equal(s.bodyCancelled, 1)
		assert.match(h.nodes["log-status"].textContent, /Error de conexión/)
	}
	const s = stream(), h = harness(() => s.response); authorized(h)
	const run = h.nodes.start.fire(); await tick()
	s.push('data: {"event":"' + 'x'.repeat(70000) + '"}\n\ndata: {"event":"after"}\n\n'); await tick()
	assert.equal(h.nodes.logs.textContent, '{"event":"after"}')
	h.nodes.stop.fire(); await run
})

// Static contract, not a browser layout measurement.
test("log CSS contract: complete unwrapped lines and bounded horizontal scroll", async () => {
 const css = await readFile(new URL("../src/web/style.css", import.meta.url), "utf8")
 const logs = /#logs\s*\{([^}]+)\}/.exec(css)?.[1]
 assert.ok(logs)
 for (const declaration of [/white-space:\s*pre;/, /overflow-wrap:\s*normal;/, /word-break:\s*normal;/, /overflow-x:\s*auto;/, /overflow-y:\s*auto;/, /min-width:\s*0;/, /max-width:\s*100%;/, /width:\s*100%;/, /box-sizing:\s*border-box;/]) assert.match(logs,declaration)
 assert.match(css,/main\s*\{[^}]*box-sizing:\s*border-box;[^}]*min-width:\s*0;[^}]*width:\s*100%;[^}]*max-width:\s*none;/)
 assert.doesNotMatch(logs,/text-overflow:\s*ellipsis|overflow(?:-x)?:\s*hidden|white-space:\s*pre-wrap/)
})


test("available percent boundaries and invalid data have truthful colors", async () => {
 for (const [usedPercent, text, color] of [[0,"100%","health-green"],[4,"96%","health-green"],[74.9,"25.1%","health-green"],[75,"25%","health-yellow"],[99.9,"0.1%","health-yellow"],[100,"0%","health-red"], ...[null,undefined,"4",NaN,Infinity,-1,101].map(v=>[v,"desconocido",undefined])]) {
  const h = harness(() => jsonResponse({ accounts: [{ circuit: {state:"closed"}, rateLimits: {rateLimits: {primary: {usedPercent, resetsAt:1791320160}}} }], fetchedAt:"2026-10-06T22:56:45.123+02:00" }));
  await h.nodes.refresh.fire();
  const percent = h.nodes.accounts.children[0].children.find(n=>n.textContent.includes("Se restablece en")).children[0];
  assert.equal(percent.textContent,`Restante ${text}`); assert.equal(percent.className,color);
  assert.match(h.nodes["account-status"].textContent,/06-10-2026 22:56/);
 }
});

test("summary trusts circuit states, not quotas or expired cooldown; missing dates not invented", async () => {
 const cases = [{state:"open",remainingMs:0,disabledUntil:null},{state:"half_open",remainingMs:0,probeInFlight:false},{state:"half_open",probeInFlight:true},{state:"closed",remainingMs:0},{state:"unexpected"},null];
 const h=harness(()=>jsonResponse({accounts:cases.map(circuit=>({circuit, error:null,rateLimits:{rateLimits:{primary:{usedPercent:100}}}}))}));
 await h.nodes.refresh.fire();
 assert.equal(h.nodes["upstream-summary"].textContent,"1 activos\n · 1 deshabilitados\n · 2 en recuperación\n · 2 sin estado disponible");
 assert.doesNotMatch(h.nodes.accounts.textContent,/Deshabilitado hasta|Cooldown|Error:|unknown|false/);
 assert.doesNotMatch(h.nodes.accounts.textContent,/Se reanuda/);
 assert.match(h.nodes.accounts.children[1].textContent,/En recuperación/);
 h.events.pagehide();assert.equal(h.nodes["upstream-summary"].textContent,"Sin datos.");
});

test("SSE dates ISO and milliseconds become Madrid; numeric metadata stays numeric", async () => {
 const s=stream(),h=harness(()=>s.response);const run=h.nodes.start.fire();await tick();
 s.push('data: {"timestamp":"2026-10-06T22:56:45.123+02:00","time":1791320160000,"disabledUntil":"2026-10-06T20:56:45Z","durationMs":1234,"remainingMs":5000,"status":200,"attempt":2}\n\n'); await tick();
 const entry=JSON.parse(h.nodes.logs.textContent);
 for(const key of ["timestamp","time","disabledUntil"])assert.equal(entry[key],"06-10-2026 22:56");
 for(const [key,v] of [["durationMs",1234],["remainingMs",5000],["status",200],["attempt",2]])assert.equal(entry[key],v);
 s.push('data: {"timestamp":null,"time":"invalid","disabledUntil":1e20}\n\n');await tick();
 const invalid=JSON.parse(h.nodes.logs.textContent.split("\n")[1]);for(const v of Object.values(invalid))assert.equal(v,"desconocido");
 h.nodes.stop.fire();await run;
});


test("no circuit header countdown regardless of expiry", async () => {
 for(const disabledUntil of ["2026-10-06T20:56:45.123Z",1791320160000,null,undefined,"later",Infinity]) {
  const h=harness(()=>jsonResponse({accounts:[{alias:"a",circuit:{state:"open",disabledUntil}}]}));await h.nodes.refresh.fire();
  assert.equal(h.nodes.accounts.children[0].children[0].textContent,"(1) a");
  assert.doesNotMatch(h.nodes.accounts.textContent,/Se reanuda/);
 }
});

const quotaRow = (h) => h.nodes.accounts.children[0].children.find(n => n.textContent.includes("Restante"));
test("fixed clock countdown 2d 1h 5m, manual refresh recalculates, exact Madrid hover", async () => {
 let now = fixedNow;
 const resetsAt = (now + (2*1440+65)*60000)/1000;
 const data = {accounts:[{circuit:{state:"closed"},rateLimits:{rateLimits:{primary:{usedPercent:31,resetsAt}}}}]};
 const h = harness(() => jsonResponse(data), () => now);
 await h.nodes.refresh.fire();
 assert.equal(quotaRow(h).children[0].textContent, "Restante 69%");
 assert.equal(quotaRow(h).children[1].textContent, " · Se restablece en 2d 1h 5m");
 assert.equal(quotaRow(h).children[1].title,"08-10-2026 15:05");
 now += 60000; await h.nodes.refresh.fire();
 assert.equal(quotaRow(h).children[1].textContent," · Se restablece en 2d 1h 4m");
 assert.equal(h.calls.length,2);
});

test("Madrid hover explicit DST summer winter and transition, updated dates", async () => {
 for (const [iso, exact] of [["2026-07-06T12:00:00Z","06-07-2026 14:00"],["2026-01-06T12:00:00Z","06-01-2026 13:00"],["2026-10-25T00:30:00Z","25-10-2026 02:30"],["2026-10-25T01:30:00Z","25-10-2026 02:30"]]) {
  const h=harness(()=>jsonResponse({fetchedAt:iso,accounts:[{circuit:{state:"open",disabledUntil:iso},rateLimits:{rateLimits:{primary:{usedPercent:31,resetsAt:Date.parse(iso)/1000}}}}]}));
  await h.nodes.refresh.fire();
  assert.equal(quotaRow(h).children[1].title,exact);
  assert.equal(h.nodes.accounts.children[0].children[0].children.length,0);
  assert.ok(h.nodes["account-status"].textContent.includes(exact));
 }
 assert.match(source,/timeZone: "Europe\/Madrid"/);
});

test("shared countdown null expired subminute and positive units without fictitious dates", async () => {
 for(const [delta,expected] of [[null,"desconocido"],[-60000,"pendiente de actualización"],[0,"pendiente de actualización"],[59000,"<1m"],[60000,"1m"],[3600000,"1h"],[86400000,"1d"],[104460000,"1d 5h 1m"]]) {
  const expiry=delta===null?null:fixedNow+delta;
  const h=harness(()=>jsonResponse({accounts:[{circuit:{state:"open",disabledUntil:expiry===null?null:new Date(expiry).toISOString(),remainingMs:999999,failures:3,clientErrors:2},rateLimits:{rateLimits:{primary:{usedPercent:null,resetsAt:expiry===null?null:expiry/1000}}}}]}));
  await h.nodes.refresh.fire();
  const circuit=h.nodes.accounts.children[0].children[0];
  const quota=quotaRow(h);
  for(const [row,label] of [[quota,"Se restablece en"]]) {
   assert.equal(row.children.at(row===circuit?0:1).textContent,` · ${delta!==null&&delta<=0?expected:label+" "+expected}`);
   assert.equal(row.children.at(row===circuit?0:1).title===undefined,delta===null);
  }
  assert.doesNotMatch(circuit.textContent,/Deshabilitado/);assert.match(h.nodes.accounts.children[0].children[1].textContent,/Errores cliente: 2/);
  assert.doesNotMatch(circuit.textContent,/Cooldown|Fallos|-[0-9]|Error: ninguno/);
  assert.equal(quota.children[0].textContent,"Restante desconocido");assert.equal(quota.children[0].className,undefined);
 }
});

test("summary two active two disabled without upstreams",async()=>{
 const h=harness(()=>jsonResponse({accounts:["closed","closed","open","open"].map(state=>({circuit:{state},error:null}))}));await h.nodes.refresh.fire();
 assert.equal(h.nodes["upstream-summary"].children.map(n=>n.textContent).join(""),"2 activos · 2 deshabilitados");
 assert.doesNotMatch(h.nodes["upstream-summary"].textContent,/upstreams/);
});

test("accounts responsive equal grid contract isolated from horizontal logs",async()=>{
 const css=await readFile(new URL("../src/web/style.css",import.meta.url),"utf8");
 assert.match(css,/#accounts\s*\{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*min-width: 0;/);
 assert.match(css,/@media \(max-width: 45rem\)\s*\{\s*#accounts\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/);
 assert.match(css,/#accounts article\s*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
});

test("SSE Madrid summer winter DST dates use same formatter",async()=>{
 const s=stream(),h=harness(()=>s.response);const run=h.nodes.start.fire();await tick();
 for(const [timestamp,exact] of [["2026-07-06T12:00:00Z","06-07-2026 14:00"],["2026-01-06T12:00:00Z","06-01-2026 13:00"]]) {
  s.push(`data: ${JSON.stringify({timestamp,time:Date.parse(timestamp),disabledUntil:timestamp})}\n\n`);await tick();
  const entry=JSON.parse(h.nodes.logs.textContent.split("\n").at(-1));
  for(const v of Object.values(entry))assert.equal(v,exact);
 }
 h.nodes.stop.fire();await run;
});

test("ordered 1-based headings carry circuit colors/countdown without duplicate state", async () => {
 const h=harness(()=>jsonResponse({accounts:[{alias:'zeta',circuit:{state:'closed'}},null,{alias:'eduard',circuit:{state:'open',disabledUntil:new Date(fixedNow+27*60000).toISOString(),clientErrors:2}},{alias:'alpha',circuit:{state:'half_open',probeInFlight:true}},{alias:'unknown',circuit:{state:'unexpected'}}]}));
 await h.nodes.refresh.fire();
 const cards=h.nodes.accounts.children, headings=cards.map(c=>c.children[0]);
 assert.deepEqual(headings.map(n=>n.textContent),['(1) zeta','(3) eduard','(4) alpha','(5) unknown']);
 assert.deepEqual(headings.map(n=>n.className),['health-green','health-red','health-yellow',undefined]);
 assert.equal(headings[1].children.length,0);
 assert.doesNotMatch(h.nodes.accounts.textContent,/Activo|Activado|Deshabilitado/);
 assert.match(cards[1].textContent,/Errores cliente: 2/);assert.match(cards[2].textContent,/En recuperación|Sonda en curso/);
 assert.match(cards[3].textContent,/Estado no disponible/);
});

test("SSE Stop/Start replay dedupes IDs not text; partial frame stays local; bounded ID memory", async () => {
 const a=stream(),b=stream(),c=stream();let calls=0;
 const h=harness(()=>[a,b,c][calls++].response);
 const frame=id=>`id: epoch:${id}\r\ndata: {"event":"same"}\r\n\r\n`;
 const first=h.nodes.start.fire();await tick();
 for(let i=0;i<205;i++){a.push(frame(i));await tick()}
 assert.equal(h.nodes.logs.textContent.split('\n').length,200);
 a.push('id: stale\ndata: {"event":"partial');await tick();h.nodes.stop.fire();await first;
 const second=h.nodes.start.fire();await tick();
 assert.equal(h.calls[1].options.headers['Last-Event-ID'],'epoch:204');
 // Ring replay remains 200 retained events: none becomes a new line.
 for(let i=5;i<205;i++){b.push(frame(i));await tick()}
 assert.equal(h.nodes.logs.textContent.split('\n').length,200);
 // Fresh identical text is valid. An evicted ID is no longer remembered (boundedness).
 b.push(frame(205));b.push('id: epoch:0\ndata: {"event":"evicted-accepted"}\n\n');await tick();
 assert.equal(h.nodes.logs.textContent.split('\n').length,200);
 assert.match(h.nodes.logs.textContent.split('\n').at(-1),/evicted-accepted/);
 assert.doesNotMatch(h.nodes.logs.textContent,/partial/);
 b.fail();await second;assert.match(h.nodes['log-status'].textContent,/Error de conexión/);
 const third=h.nodes.start.fire();await tick();assert.equal(h.nodes['log-status'].textContent,'');
 c.push('id: new-epoch:1\ndata: {"event":"after-error"}\n\n');await tick();
 assert.match(h.nodes.logs.textContent,/after-error/);
 h.nodes.stop.fire();await third;h.events.pagehide();
 assert.equal(h.nodes.logs.textContent,'');
 for(const s of [a,b,c]){assert.equal(s.cancelled,1);assert.equal(s.released,1)}
});

test("SSE reconnect shows each replay once and accepts identical text under a new ID",async()=>{
 const a=stream(),b=stream();let count=0;const h=harness(()=>++count===1?a.response:b.response);
 const frame=id=>`id: run:${id}\ndata: {"event":"identical"}\n\n`;
 const first=h.nodes.start.fire();await tick();a.push(frame(1));a.push(frame(2));await tick();
 assert.equal(h.nodes.logs.textContent.split('\n').length,2);
 h.nodes.stop.fire();await first;
 const second=h.nodes.start.fire();await tick();b.push(frame(1));b.push(frame(2));await tick();
 assert.equal(h.nodes.logs.textContent.split('\n').length,2);
 b.push(frame(3));await tick();assert.equal(h.nodes.logs.textContent.split('\n').length,3);
 assert.ok(h.nodes.logs.textContent.split('\n').every(line=>line==='{"event":"identical"}'));
 h.nodes.stop.fire();await second;
});

test("central Router wrapper excludes full-width logs", async () => {
 const css = await readFile(new URL("../src/web/style.css", import.meta.url), "utf8");
 assert.match(html, /<div id="router-panel">\s*<h1>Router<\/h1>[\s\S]*?<section id="accounts"[^>]*><\/section>\s*<\/div>\s*<section aria-labelledby="log-title">/);
 assert.match(css, /#router-panel\s*\{[^}]*width: 100%;[^}]*max-width: 72rem;[^}]*margin-inline: auto;/);
 assert.match(css, /main\s*\{[^}]*max-width: none;[^}]*padding: 1\.5rem;/);
 assert.match(css, /#logs\s*\{[^}]*overflow-anchor: none;/);
});

test("log scroll follows by default, upward pauses, bottom tolerance resumes and Stop/Start preserves intention", async () => {
 const a=stream(),b=stream(),c=stream();let count=0;
 const h=harness(()=>[a,b,c][count++].response),logs=h.nodes.logs;
 const frame=id=>`id: scroll:${id}\ndata: {"event":"row-${id}"}\n\n`;
 const first=h.nodes.start.fire();await tick();
 for(let i=0;i<10;i++)a.push(frame(i));await tick();
 assert.equal(logs.scrollTop,logs.scrollHeight-logs.clientHeight);
 logs.scrollLeft=17;logs.scrollTop=40;logs.fire("scroll");
 a.push(frame(10));await tick();assert.equal(logs.scrollTop,40);assert.equal(logs.scrollLeft,17);
 h.nodes.stop.fire();await first;
 const second=h.nodes.start.fire();await tick();
 b.push(frame(10));b.push(frame(11));await tick();
 assert.equal(logs.textContent.split('\n').length,12);assert.equal(logs.scrollTop,40);
 logs.scrollTop=logs.scrollHeight-logs.clientHeight-5;logs.fire("scroll");
 const paused=logs.scrollTop;b.push(frame(12));await tick();assert.equal(logs.scrollTop,paused);
 logs.scrollTop=logs.scrollHeight-logs.clientHeight-3;logs.fire("scroll");
 b.push(frame(13));await tick();assert.equal(logs.scrollTop,logs.scrollHeight-logs.clientHeight);
 h.nodes.stop.fire();await second;
 const third=h.nodes.start.fire();await tick();c.push(frame(14));await tick();
 assert.equal(logs.scrollTop,logs.scrollHeight-logs.clientHeight);
 h.events.pagehide();await third;assert.equal(logs.listeners.scroll,undefined);
 assert.equal(logs.textContent,'');h.events.pageshow();assert.equal(typeof logs.listeners.scroll,'function');
});

test("log scroll cap 200 preserves paused rows rather than jumping to bottom; eviction clamps at top",async()=>{
 const s=stream(),h=harness(()=>s.response),logs=h.nodes.logs;
 const frame=id=>`id: cap:${id}\ndata: {"event":"row-${id}"}\n\n`;
 const run=h.nodes.start.fire();await tick();
 for(let i=0;i<200;i++){s.push(frame(i));await tick()}
 assert.equal(logs.scrollTop,3940);
 logs.scrollTop=1000;logs.fire('scroll');
 s.push(frame(200));await tick();assert.equal(logs.scrollTop,980);
 assert.match(logs.textContent.split('\n')[logs.scrollTop/20],/row-50/);
 s.push(frame(201));await tick();assert.equal(logs.scrollTop,960);
 logs.scrollTop=10;logs.fire('scroll');s.push(frame(202));await tick();assert.equal(logs.scrollTop,0);
 s.push(frame(203));await tick();assert.equal(logs.scrollTop,0);assert.equal(logs.textContent.split('\n').length,200);
 logs.scrollTop=logs.scrollHeight-logs.clientHeight;logs.fire('scroll');s.push(frame(204));await tick();
 assert.equal(logs.scrollTop,3940);assert.equal(logs.textContent.split('\n').length,200);
 h.nodes.stop.fire();await run;
});

test('recovery origin distinguishes generic and quota without hiding genuine half-open with 100 percent available',async()=>{
 const h=harness(()=>jsonResponse({accounts:[
  {alias:'fresh',circuit:{state:'closed',recoveryOrigin:null},rateLimits:{rateLimits:{primary:{usedPercent:0},secondary:{usedPercent:0}}}},
  {alias:'generic',circuit:{state:'half_open',recoveryOrigin:'generic',probeInFlight:true},rateLimits:{rateLimits:{primary:{usedPercent:0},secondary:{usedPercent:0}}}},
  {alias:'quota',circuit:{state:'half_open',recoveryOrigin:'quota'}},
  {alias:'both',circuit:{state:'half_open',recoveryOrigin:'generic_and_quota'}}
 ]}));await h.nodes.refresh.fire()
 assert.doesNotMatch(h.nodes.accounts.children[0].textContent,/En recuperación/)
 assert.match(h.nodes.accounts.children[1].textContent,/En recuperación · Origen: errores del upstream/)
 assert.match(h.nodes.accounts.children[1].textContent,/Restante 100%/)
 assert.match(h.nodes.accounts.children[2].textContent,/cuota pendiente de verificar/)
 assert.match(h.nodes.accounts.children[3].textContent,/errores del upstream y cuota/)
 assert.match(h.nodes['upstream-summary'].textContent,/1 activos\n · 0 deshabilitados\n · 3 en recuperación/)
})

test('clientAddress JSON -> sanitized SSE -> viewer validates IPv4 mapped IPv6 ports and rejects injection',async()=>{
 const {createLogHub}=await import('../src/observability.mjs')
 const {createLogger}=await import('../src/logger.mjs')
 const {EventEmitter}=await import('node:events')
 const s=stream(),h=harness(()=>s.response),run=h.nodes.start.fire();await tick()
 const hub=createLogHub(),lines=[],logger=createLogger({output:line=>lines.push(line),onRecord:hub.publish})
 const valid=['192.0.2.1:5000','::ffff:192.0.2.1','[::ffff:192.0.2.1]:5000','[2001:db8::1]:5000','::1','192.0.2.1:80','[::1]:443','2001:db8::1']
 const expected=['192.0.2.1:5000','192.0.2.1','192.0.2.1:5000','[2001:db8::1]:5000','::1','192.0.2.1','::1','2001:db8::1']
 for(const clientAddress of valid)logger.info('request_complete',{requestId:'abc',clientAddress,body:'PRIVATE'})
 class Sink extends EventEmitter {writeHead(){}write(frame){s.push(frame);return true}destroy(){this.emit('close')}}
 const sink=new Sink();hub.connect(sink);await tick()
 const displayed=h.nodes.logs.textContent.split('\n').map(JSON.parse)
 assert.deepEqual(displayed.map(r=>r.clientAddress),expected)
 assert.deepEqual(lines.map(line=>JSON.parse(line.slice(line.indexOf('{'))).clientAddress),expected)
 // Bypass server sanitizer to exercise browser's independent boundary.
 const bad=['unknown','evil.example:80','999.1.1.1','[::1]:65536','[::1]:0','[1:2:3]:123','fe80::1%eth0','127.0.0.1:12\n<script>','<img onerror=alert(1)>','x'.repeat(100),null,{}]
 for(const clientAddress of bad){s.push(`data: ${JSON.stringify({event:'bad',clientAddress})}\n\n`);await tick()}
 for(const clientAddress of valid){s.push(`data: ${JSON.stringify({event:'direct',clientAddress})}\n\n`);await tick()}
 await tick()
 const all=h.nodes.logs.textContent.split('\n').map(JSON.parse)
 assert.ok(all.slice(valid.length,valid.length+bad.length).every(r=>!Object.hasOwn(r,'clientAddress')))
 assert.deepEqual(all.slice(-valid.length).map(r=>r.clientAddress),expected)
 assert.ok(!h.nodes.logs.textContent.includes('PRIVATE'))
 hub.close();h.nodes.stop.fire();await run
})

test('usage scalar viewer allowlist, unknown null, invalid numbers and private fields excluded',async()=>{
 const s=stream(),h=harness(()=>s.response)
 const task=h.nodes.start.fire();await tick()
 s.push('data: '+JSON.stringify({event:'usage_attempt',inputTokens:0,outputTokens:null,totalTokens:15,cachedTokens:-1,reasoningTokens:'private',endpoint:'/v1/responses',outcome:'interrupted',usageStatus:'upstream_reported',provenance:'responses_upstream_reported',modelStatus:'completed',prompt:'PRIVATE_PROMPT',usage:{output:'PRIVATE_RESPONSE'}})+'\n\n')
 await tick()
 const text=h.nodes.logs.textContent
 assert.match(text,/"inputTokens":0/);assert.match(text,/"outputTokens":null/);assert.match(text,/"totalTokens":15/);assert.match(text,/"modelStatus":"completed"/)
 assert.doesNotMatch(text,/cachedTokens|reasoningTokens|PRIVATE|prompt|"usage":/)
 h.nodes.stop.fire();await task
})


test("quota labels stay neutral for arbitrary, invalid and absent window durations", async () => {
 for (const windowDurationMins of [17, 300, 10080, null, undefined, 0, -1, "300", Infinity, NaN, "<script>private</script>"]) {
  const h = harness(() => jsonResponse({accounts:[{rateLimits:{rateLimits:{
   primary:{usedPercent:33,resetsAt:1791300394,windowDurationMins},
   secondary:{usedPercent:0,resetsAt:null,windowDurationMins},
  }}}]}));
  await h.nodes.refresh.fire();
  const card=h.nodes.accounts.children[0];
  assert.equal(card.children.filter(n=>n.textContent==="Límite 5h").length,1);
  assert.equal(card.children.filter(n=>n.textContent==="Límite semanal").length,1);
  assert.doesNotMatch(card.textContent,/Límite 5h|setmanal|semanal|<script>|private/);
  assert.match(card.textContent,/Restante 67%/);
  assert.match(card.textContent,/Se restablece en 3h 26m/);
 }
});
