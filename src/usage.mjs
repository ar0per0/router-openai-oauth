import { Transform } from 'node:stream'
const integer = v => Number.isSafeInteger(v) && v >= 0 ? v : null
export const metrics = ['inputTokens','outputTokens','totalTokens','cachedTokens','reasoningTokens']
export const normalizeUsage = (u = {}, chat = false) => ({
 inputTokens: integer(u[chat ? 'prompt_tokens' : 'input_tokens']),
 outputTokens: integer(u[chat ? 'completion_tokens' : 'output_tokens']),
 totalTokens: integer(u.total_tokens),
 cachedTokens: integer(u[chat ? 'prompt_tokens_details' : 'input_tokens_details']?.cached_tokens),
 reasoningTokens: integer(u[chat ? 'completion_tokens_details' : 'output_tokens_details']?.reasoning_tokens),
})
// Incremental selective JSON lexer/parser. Unselected strings are discarded while
// lexing, not buffered. Only fixed numeric usage paths and type are retained.
class SelectJSON {
 constructor() { this.stack = []; this.mode = ''; this.token = ''; this.escape = false; this.unicode = 0; this.values = {}; this.done = false; this.rootStarted = false }
 path() { const p = this.stack.at(-1); return p ? [...p.path, p.kind === '{' ? p.key : '*'] : [] }
 selected(path) { return /^(type|status|response\.status|usage\.(prompt_tokens|completion_tokens|input_tokens|output_tokens|total_tokens|prompt_tokens_details.cached_tokens|completion_tokens_details.reasoning_tokens|input_tokens_details.cached_tokens|output_tokens_details.reasoning_tokens)|response\.usage\.(input_tokens|output_tokens|total_tokens|input_tokens_details.cached_tokens|output_tokens_details.reasoning_tokens))$/.test(path.join('.')) }
 value(v) { const path = this.path(); if (this.selected(path)) this.values[path.join('.')] = v; this.accept() }
 accept() { const p = this.stack.at(-1); if (!p) { if (this.done) throw Error(); this.done = true } else { if (!['value','first'].includes(p.state)) throw Error(); p.state = 'comma' } }
 start(c) { const p = this.stack.at(-1); if (p && !['value','first'].includes(p.state)) throw Error(); if (!p && (this.done || this.rootStarted)) throw Error(); if (!p) this.rootStarted = true; const path = this.path(); if (this.stack.length >= 64) throw Error(); this.stack.push({ kind:c, path, state:c === '{' ? 'keyFirst' : 'first', key:'' }) }
 punctuation(c) { const p = this.stack.at(-1); if (c === '{' || c === '[') return this.start(c); if (!p) throw Error(); if (c === ':' && p.kind === '{' && p.state === 'colon') { p.state = 'value'; return }
 if (c === ',' && p.state === 'comma') { p.state = p.kind === '{' ? 'key' : 'value'; return }
 if ((c === '}' && p.kind === '{' && ['comma','keyFirst'].includes(p.state)) || (c === ']' && p.kind === '[' && ['comma','first'].includes(p.state))) { if (p.path.join('.') === 'choices') this.values.emptyChoices = p.state === 'first'; this.stack.pop(); this.accept(); return } throw Error() }
 feed(text) { for (const c of text) {
  if (this.mode === 'string') {
   if (this.unicode) { if (!/[0-9a-f]/i.test(c)) throw Error(); this.unicode--; if (this.keep) this.token += c; continue }
   if (this.escape) { if (!/["\\/bfnrtu]/.test(c)) throw Error(); this.escape = false; if (c === 'u') this.unicode = 4; if (this.keep) this.token += c; continue }
   if (c === '\\') { this.escape = true; if (this.keep) this.token += c; continue }
   if (c === '"') { const value = this.keep ? JSON.parse('"'+this.token+'"') : null; this.mode = ''; const p = this.stack.at(-1); if (p && ['key','keyFirst'].includes(p.state)) { p.key = value; p.state = 'colon' } else this.value(value); continue }
   if (c.charCodeAt(0) < 32) throw Error(); if (this.keep) { this.token += c; if (this.token.length > 256) throw Error() } continue
  }
  if (this.mode === 'literal') { if (/[a-zA-Z0-9+.\-]/.test(c)) { this.token += c; if (this.token.length > 128) throw Error(); continue } this.value(JSON.parse(this.token)); this.mode = '' }
  if (/\s/.test(c)) continue
  if ('{}[]:,'.includes(c)) { this.punctuation(c); continue }
  const p = this.stack.at(-1)
  if (c === '"') { this.mode = 'string'; this.token = ''; this.keep = !!(p && ['key','keyFirst'].includes(p.state)) || this.selected(this.path()); continue }
  if (!p || !['value','first'].includes(p.state)) throw Error(); this.mode = 'literal'; this.token = c
 } }
 finish() { if (this.mode === 'literal') { this.value(JSON.parse(this.token)); this.mode = '' } if (this.mode || this.stack.length || !this.done) throw Error(); return this.values }
}
export const createUsageObserver = (endpoint, headers = {}, { maxBytes = 16777216 } = {}) => {
 const chat = endpoint === '/v1/chat/completions'; const sse = /^text\/event-stream(?:;|$)/i.test(headers['content-type'] || '')
 let disabled = !['/v1/responses','/v1/chat/completions'].includes(endpoint) || (!!headers['content-encoding'] && headers['content-encoding'] !== 'identity') || !/^(application\/json|text\/event-stream)(?:;|$)/i.test(headers['content-type'] || '') || /charset\s*=\s*(?!utf-8(?:[;\s]|$))/i.test(headers['content-type'] || '')
 const decoder = new TextDecoder('utf-8', { fatal:true }); let parser = new SelectJSON(), bytes = 0, prefix = '', dataLine = false, previousCR = false, eventData = false, eventPrefix = '', doneEvent = false, candidate = null, seen = false
 let result = { ...normalizeUsage(), usageStatus:'unknown', provenance:'none', modelStatus:'unknown' }
 const accept = values => {
  const type = values.type
  const terminal = chat ? (!sse || values.emptyChoices === true) : (!sse || ['response.completed','response.failed','response.incomplete'].includes(type))
  if (!terminal) return
  const u = {}; for (const [key,v] of Object.entries(values)) { const path = key.replace(/^response\./,'').split('.'); if (path.shift() !== 'usage') continue; if (path.length === 1) u[path[0]] = v; else { u[path[0]] ??= {}; u[path[0]][path[1]] = v } }
  const reportedStatus = values['response.status'] ?? values.status
  const modelStatus = chat ? 'unknown' : ['completed','failed','incomplete'].includes(reportedStatus) ? reportedStatus : sse ? type.slice(9) : 'unknown'
  result.modelStatus = modelStatus
  const m = normalizeUsage(u, chat); if (!metrics.some(k => m[k] !== null)) return
  // Repeated identical cumulative terminal chunks are measurements, not deltas.
  if (seen && JSON.stringify(candidate) !== JSON.stringify(m)) throw Error()
  seen = true; candidate = m; result = { ...m, modelStatus, usageStatus:'upstream_reported', provenance:chat ? 'chat_adapter_reported_zero_ambiguous' : 'responses_upstream_reported' }
 }
 const feedData = c => {
  if (doneEvent) { if (!/\s/.test(c)) throw Error(); return }
  if (eventPrefix !== null) { eventPrefix += c; if ('[DONE]'.startsWith(eventPrefix)) { if (eventPrefix === '[DONE]') doneEvent = true; return } parser.feed(eventPrefix); eventPrefix = null; return }
  parser.feed(c)
 }
 const endLine = () => {
  if (dataLine) { feedData('\n'); eventData = true }
  else if (prefix === '' && eventData) { if (!doneEvent) accept(parser.finish()); parser = new SelectJSON(); eventData = false; eventPrefix = ''; doneEvent = false }
  prefix = ''; dataLine = false
 }
 const consume = text => {
  if (!sse) { parser.feed(text); return }
  for (const c of text) {
   if (c === '\n' && previousCR) { previousCR = false; continue }
   previousCR = c === '\r'
   if (c === '\r' || c === '\n') { endLine(); continue }
   if (dataLine) { if (prefix === 'space') { prefix = 'started'; if (c === ' ') continue } feedData(c) }
   else { if (prefix.length < 6) prefix += c; if (prefix === 'data:') { dataLine = true; prefix = 'space' } }
  }
 }
 const fail = () => { disabled = true; result = { ...normalizeUsage(), usageStatus:'unknown', provenance:'observation_unavailable', modelStatus:'unknown' } }
 const stream = new Transform({ transform(chunk, encoding, callback) { if (!disabled) try { bytes += chunk.length; if (bytes > maxBytes) throw Error(); consume(decoder.decode(chunk, { stream:true })) } catch { fail() } callback(null, chunk) }, flush(callback) { if (!disabled) try { consume(decoder.decode()); if (!sse) accept(parser.finish()); else if (eventData || dataLine) throw Error() } catch { fail() } callback() } })
 // [DONE] is handled by the fixed-size prefix check, not JSON parsing.
 return { stream, snapshot: () => ({ ...result }) }
}
