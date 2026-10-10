"use strict";
(() => {
	const el = (id) => document.getElementById(id);
	const refresh = el("refresh"), accounts = el("accounts");
	const accountStatus = el("account-status"), logStatus = el("log-status");
	const upstreamSummary = el("upstream-summary");
	const start = el("start"), stop = el("stop"), logs = el("logs");
	let refreshTask = null, viewer = null;
	const lines = [], seenIds = new Set();
	let lastEventId = null;
	let followLogs = true;
	const trackLogScroll = () => {
		followLogs = logs.scrollHeight - logs.clientHeight - logs.scrollTop <= 4;
	};
	const listenLogScroll = () => logs.addEventListener("scroll", trackLogScroll);
	listenLogScroll();
	const unknown = "desconocido";
	const value = (v) => v == null ? unknown : String(v);
	const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
	const append = (parent, tag, text) => {
		const node = document.createElement(tag);
		node.textContent = text;
		parent.appendChild(node);
		return node;
	};
	// Explicit UI zone, independent of server/browser TZ; backend units stay unchanged.
	const madrid = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/Madrid", day: "2-digit", month: "2-digit", year: "numeric",
		hour: "2-digit", minute: "2-digit", hourCycle: "h23",
	});
	const timestamp = (v, unit = "milliseconds") => {
		let ms;
		if (typeof v === "number" && Number.isFinite(v)) ms = unit === "seconds" ? v * 1000 : v;
		else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v)) ms = Date.parse(v);
		else return null;
		const date = new Date(ms);
		return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999 ? ms : null;
	};
	const dateView = (v, unit = "milliseconds") => {
		const ms = timestamp(v, unit);
		if (ms === null) return unknown;
		const parts = Object.fromEntries(madrid.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
		return `${parts.day}-${parts.month}-${parts.year.padStart(4, "0")} ${parts.hour}:${parts.minute}`;
	};
	const durationView = (ms) => {
		if (ms === null) return unknown;
		if (ms <= 0) return "pendiente de actualización";
		let minutes = Math.floor(ms / 60000);
		if (!minutes) return "<1m";
		const days = Math.floor(minutes / 1440);
		minutes %= 1440;
		const hours = Math.floor(minutes / 60);
		minutes %= 60;
		return [[days, "d"], [hours, "h"], [minutes, "m"]].filter(([n]) => n > 0).map(([n, unit]) => `${n}${unit}`).join(" ");
	};
	// Share countdown/hover for quotas and circuits; never derive a date from remainingMs.
	const countdown = (parent, label, v, unit, now) => {
		const ms = timestamp(v, unit);
		const remaining = ms === null ? null : ms - now;
		const text = remaining !== null && remaining <= 0 ? "pendiente de actualización" : `${label} ${durationView(remaining)}`;
		const node = append(parent, "span", ` · ${text}`);
		const exact = dateView(v, unit);
		if (exact !== unknown) node.title = exact;
	};
	const windowView = (parent, name, w, now) => {
		append(parent, "h4", name);
		const used = object(w) ? w.usedPercent : null;
		const available = typeof used === "number" && Number.isFinite(used) && used >= 0 && used <= 100 ? 100 - used : null;
		const row = append(parent, "p", "");
		const percent = append(row, "span", available === null ? "Restante desconocido" : `Restante ${Number(available.toFixed(10))}%`);
		if (available !== null) percent.className = available > 25 ? "health-green" : available > 0 ? "health-yellow" : "health-red";
		countdown(row, "Se restablece en", object(w) ? w.resetsAt : null, "seconds", now);
	};
	const snapshot = (parent, s, now) => {
		windowView(parent, "Límite 5h", object(s) ? s.primary : null, now);
		windowView(parent, "Límite semanal", object(s) ? s.secondary : null, now);
	};
	const circuitState = (c) => ["closed", "open", "half_open"].includes(c.state) ? c.state : null;
	const circuitView = (parent, heading, c, now) => {
		const state = circuitState(c);
		if (state) heading.className = { closed: "health-green", open: "health-red", half_open: "health-yellow" }[state];
		const row = append(parent, "p", state === "half_open" ? "En recuperación" : state === null ? "Estado no disponible" : "");
		if (state === "half_open") {
			const origin = { generic: "errores del upstream", quota: "cuota pendiente de verificar", generic_and_quota: "errores del upstream y cuota" }[c.recoveryOrigin];
			if (origin) append(row, "span", ` · Origen: ${origin}`);
		}
		if (typeof c.clientErrors === "number" && Number.isFinite(c.clientErrors) && c.clientErrors > 0) append(row, "span", ` · Errores cliente: ${c.clientErrors}`);
		if (c.probeInFlight === true) append(row, "span", " · Sonda en curso");
	};
	const render = (data) => {
		if (!object(data) || !Array.isArray(data.accounts)) throw new Error("invalid response");
		accounts.replaceChildren();
		const now = Date.now();
		const counts = { closed: 0, open: 0, half_open: 0, unavailable: 0 };
		for (const [index, a] of data.accounts.entries()) {
			if (!object(a)) continue;
			const card = append(accounts, "article", "");
			const heading = append(card, "h2", `(${index + 1}) ${value(a.alias)}`);
			const c = object(a.circuit) ? a.circuit : {};
			counts[circuitState(c) ?? "unavailable"]++;
			circuitView(card, heading, c, now);
			if (a.error != null && a.error !== "") append(card, "p", `Error: ${value(a.error)}`);
			const r = object(a.rateLimits) ? a.rateLimits : {};
			snapshot(card, r.rateLimits, now);
		}
		upstreamSummary.replaceChildren();
		append(upstreamSummary, "span", `${counts.closed} activos`).className = "health-green";
		append(upstreamSummary, "span", ` · ${counts.open} deshabilitados`).className = "health-red";
		if (counts.half_open) append(upstreamSummary, "span", ` · ${counts.half_open} en recuperación`).className = "health-yellow";
		if (counts.unavailable) append(upstreamSummary, "span", ` · ${counts.unavailable} sin estado disponible`);
		accountStatus.textContent = `Actualizado: ${dateView(data.fetchedAt)} · ${data.accounts.length} cuentas`;
	};
	const options = (controller) => ({ method: "GET", signal: controller.signal, credentials: "omit", cache: "no-store", redirect: "error" });
	const refreshAccounts = async () => {
		refreshTask?.abort();
		const task = new AbortController();
		refreshTask = task;
		refresh.disabled = true;
		accountStatus.textContent = "Consultando…";
		try {
			const response = await fetch("/router/accounts/rate-limits?refresh=1", options(task));
			if (refreshTask !== task) return;
			if (!response.ok) throw new Error("http");
			const data = await response.json();
			if (refreshTask === task) render(data);
		} catch {
			if (refreshTask === task) { accounts.replaceChildren(); upstreamSummary.textContent = "Sin datos."; accountStatus.textContent = "No se pudieron consultar las cuotas. Verifica conexión y ruta."; }
		} finally {
			if (refreshTask === task) { refreshTask = null; refresh.disabled = false; }
		}
	};
	refresh.addEventListener("click", refreshAccounts);
	// No raw messages, headers, URLs, payloads, tokens or nested arbitrary objects.
	const fields = new Set(["timestamp", "time", "disabledUntil", "level", "event", "requestId", "alias", "status", "statusCode", "durationMs", "method", "attempt", "attempts", "index", "upstreamIndex", "state", "remainingMs", "failures", "clientErrors", "probeInFlight", "logProgress"]);
	// Independently validate this IP-only field even for malformed/hostile SSE.
	const clientAddress = (v) => {
		if (typeof v !== "string" || v.length > 64) return null;
		const ipv4 = (ip) => /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip) && ip.split(".").every(n => Number(n) <= 255);
		const ipv6 = (ip) => {
			if (!/^[0-9a-fA-F:.]{2,45}$/.test(ip) || !ip.includes(":")) return false;
			// Validate compression, group counts and embedded IPv4 without accepting URL syntax.
			if (ip.includes(".")) {
				const last = ip.lastIndexOf(":");
				if (!ipv4(ip.slice(last + 1))) return false;
				ip = ip.slice(0, last + 1) + "0:0";
			}
			const halves = ip.split("::");
			if (halves.length > 2) return false;
			const groups = halves.flatMap(part => part === "" ? [] : part.split(":"));
			return groups.every(group => /^[0-9a-fA-F]{1,4}$/.test(group)) && (halves.length === 2 ? groups.length < 8 : groups.length === 8);
		};
		let ip = v, port;
		const match = /^(?:\[([0-9a-fA-F:.]+)\]|(\d+\.\d+\.\d+\.\d+)):(\d{1,5})$/.exec(v);
		if (match) {
			ip = match[1] ?? match[2]; port = Number(match[3]);
			if (port < 1 || port > 65535 || !(match[1] ? ipv6(ip) : ipv4(ip))) return null;
		} else if (!ipv4(ip) && !ipv6(ip)) return null;
		if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
		return port && port !== 80 && port !== 443 ? `${ipv6(ip) ? `[${ip}]` : ip}:${port}` : ip;
	};
	const metadata = (data) => {
		if (!object(data)) return null;
		const safe = {};
		for (const source of [data, object(data.details) ? data.details : {}]) {
			for (const [key, v] of Object.entries(source)) {
                if (['inputTokens','outputTokens','totalTokens','cachedTokens','reasoningTokens'].includes(key)) {
                 if (v === null || Number.isSafeInteger(v) && v >= 0) safe[key] = v;
                 continue;
                }
                if (['outcome','usageStatus','provenance','modelStatus'].includes(key)) {
                 if (typeof v === 'string' && /^[a-z_]{1,80}$/.test(v)) safe[key] = v;
                 continue;
                }
                if (key === 'endpoint') { if (['/v1/responses','/v1/chat/completions'].includes(v)) safe[key] = v; continue; }

				if (key === "clientAddress") {
					const address = clientAddress(v);
					if (address !== null) safe.clientAddress = address;
					continue;
				}
				if (fields.has(key) && (v === null || ["string", "number", "boolean"].includes(typeof v))) safe[key] = ["timestamp", "time", "disabledUntil"].includes(key) ? dateView(v) : typeof v === "string" ? v.slice(0, 2000) : v;
			}
		}
		return Object.keys(safe).length ? JSON.stringify(safe) : null;
	};
	const addLog = (data, id) => {
		try {
			const text = metadata(JSON.parse(data));
			if (text === null || (id && seenIds.has(id))) return;
			const top = logs.scrollTop, left = logs.scrollLeft;
			let removedHeight = 0;
			// Measure the evicted row before appending; retain the same visible rows.
			// CSS disables native anchoring so it cannot double-compensate this offset.
			if (!followLogs && lines.length === 200) {
				const height = logs.scrollHeight;
				logs.textContent = lines.slice(1).map((entry) => entry.text).join("\n");
				removedHeight = height - logs.scrollHeight;
			}
			lines.push({ text, id });
			if (id) seenIds.add(id);
			if (lines.length > 200) {
				const removed = lines.shift();
				if (removed.id) seenIds.delete(removed.id);
			}
			logs.textContent = lines.map((entry) => entry.text).join("\n");
			logs.scrollTop = followLogs ? logs.scrollHeight : Math.max(0, top - removedHeight);
			logs.scrollLeft = left;
		} catch { /* Non-JSON log frames are intentionally ignored. */ }
	};
	const cancelReader = (task) => {
		if (task.reader && !task.cancellation) task.cancellation = Promise.resolve().then(() => task.reader.cancel()).catch(() => {});
		return task.cancellation;
	};
	const disconnect = () => {
		const task = viewer;
		viewer = null;
		if (task) { task.controller.abort(); cancelReader(task); }
		start.disabled = false; stop.disabled = true;
		logStatus.textContent = "";
	};
	stop.addEventListener("click", disconnect);
	start.addEventListener("click", async () => {
		if (viewer) return;
		const task = { controller: new AbortController(), reader: null, cancellation: null };
		viewer = task;
		start.disabled = true; stop.disabled = false;

		try {
			const requestOptions = options(task.controller);
			if (lastEventId) requestOptions.headers = { "Last-Event-ID": lastEventId };
			const response = await fetch("/router/logs", requestOptions);
			if (viewer !== task) { await response.body?.cancel(); return; }
			if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
				await response.body?.cancel();
				throw new Error("invalid stream");
			}
			task.reader = response.body.getReader();
			logStatus.textContent = "";
			const decoder = new TextDecoder();
			let line = "", data = [], eventId = null, size = 0, discard = false, previousCR = false;
			const acceptLine = () => {
				if (line === "") {
					if (!discard && data.length && viewer === task) {
						addLog(data.join("\n"), eventId);
						if (eventId) lastEventId = eventId;
					}
					data = []; eventId = null; size = 0; discard = false;
				} else if (!discard && line.startsWith("id:")) {
					const id = line.slice(3).replace(/^ /, "");
					eventId = id.length > 0 && id.length <= 128 && !id.includes("\0") ? id : null;
				} else if (!discard && (line === "data" || line.startsWith("data:"))) {
					const part = line === "data" ? "" : line.slice(5).replace(/^ /, "");
					size += part.length + 1;
					if (size > 65536) { discard = true; data = []; } else data.push(part);
				}
				line = "";
			};
			const consume = (text) => {
				for (const char of text) {
					if (char === "\n" && previousCR) { previousCR = false; continue; }
					previousCR = char === "\r";
					if (char === "\r" || char === "\n") acceptLine();
					else if (line.length < 65536) line += char;
					else { discard = true; data = []; }
				}
			};
			while (viewer === task) {
				const chunk = await task.reader.read();
				if (viewer !== task) break;
				if (chunk.done) { consume(decoder.decode()); break; }
				consume(decoder.decode(chunk.value, { stream: true }));
			}
			if (viewer === task) logStatus.textContent = "";
		} catch {
			if (viewer === task) logStatus.textContent = "Error de conexión. Verifica conexión y ruta; reconexión manual.";
		} finally {
			await cancelReader(task);
			try { task.reader?.releaseLock(); } catch { /* A cancelled reader may already be released. */ }
			if (viewer === task) { viewer = null; start.disabled = false; stop.disabled = true; }
		}
	});
	const clear = () => {
		disconnect();
		refreshTask?.abort(); refreshTask = null; refresh.disabled = false;
		upstreamSummary.textContent = "Sin datos.";
		logs.removeEventListener("scroll", trackLogScroll);
		accounts.replaceChildren(); lines.length = 0; seenIds.clear(); lastEventId = null; logs.textContent = "";
		followLogs = true; logs.scrollTop = 0;
		accountStatus.textContent = "Sin datos. Pulsa Refrescar.";
	};
	window.addEventListener("pagehide", clear);
	// A bfcache restore reuses this script: reattach the listener removed on pagehide.
	window.addEventListener("pageshow", listenLogScroll);
	void refreshAccounts();
})();
