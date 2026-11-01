import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createUsageObserver } from '../src/usage.mjs'
import { sanitizeLog } from '../src/observability.mjs'

test('observation failures expose bounded reason codes, never response content', async () => {
 const terminal = usage => `data: ${JSON.stringify({ type:'response.completed', response:{ usage } })}\n\n`
 const cases = [
  ['{"private":"secret",', {}, {}, 'invalid_json'],
  ['data: {"private":"secret"\n\n', {'content-type':'text/event-stream'}, {}, 'invalid_sse_json'],
  [Buffer.from([255]), {}, {}, 'invalid_utf8'],
  ['{"usage":{}}', {}, {maxBytes:2}, 'response_size_limit'],
  ['['.repeat(65)+']'.repeat(65), {}, {}, 'json_depth_limit'],
  [terminal({input_tokens:1})+terminal({input_tokens:2}), {'content-type':'text/event-stream'}, {}, 'conflicting_usage'],
  ['data: [DONE]private\n\n', {'content-type':'text/event-stream'}, {}, 'invalid_done_event'],
 ]
 for (const [body, headers, options, reason] of cases) {
  const observer = createUsageObserver('/v1/responses', {'content-type':'application/json', ...headers}, options)
  const chunks = []
  await pipeline(Readable.from([Buffer.from(body)]), observer.stream, new Writable({write(chunk, encoding, cb) {chunks.push(chunk); cb()}}))
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(body))
  const result = observer.snapshot()
  assert.equal(result.observationError, reason)
  assert.equal(result.totalTokens, null)
  const log = sanitizeLog('info','usage_attempt',result)
  assert.equal(log.observationError, reason)
  assert.ok(!JSON.stringify(log).includes('secret'))
 }
 assert.ok(!('observationError' in sanitizeLog('info','usage_attempt',{observationError:'private secret'})))
})
