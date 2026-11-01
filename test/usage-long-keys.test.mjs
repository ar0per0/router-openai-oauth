import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createUsageObserver } from '../src/usage.mjs'

const usage = { input_tokens: 120, output_tokens: 35, total_tokens: 155 }
const response = {
 status: 'completed',
 output: [{ type: 'function_call', parameters: { ['custom_'.repeat(1000) + '\\"💡']: 'discarded' } }],
 usage,
}

for (const streaming of [false, true]) test(`long tool/schema keys preserve usage (${streaming ? 'SSE' : 'JSON'})`, async () => {
 const body = Buffer.from(streaming
  ? `data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`
  : JSON.stringify(response))
 const observer = createUsageObserver('/v1/responses', { 'content-type': streaming ? 'text/event-stream' : 'application/json' })
 const chunks = []
 await pipeline(Readable.from(Array.from(body, byte => Buffer.from([byte]))), observer.stream,
  new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback() } }))
 assert.deepEqual(Buffer.concat(chunks), body)
 const result = observer.snapshot()
 assert.equal(result.inputTokens, 120)
 assert.equal(result.outputTokens, 35)
 assert.equal(result.totalTokens, 155)
 assert.equal(result.provenance, 'responses_upstream_reported')
 assert.equal(result.modelStatus, 'completed')
})
