import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createLogHub } from '../src/observability.mjs';

test('full SSE history survives backpressure and continues with live events and heartbeat', async () => {
 const hub = createLogHub({ heartbeatMs: 25 });
 for (let i = 0; i < 200; i++) hub.publish('info', 'probe', { index: i, alias: 'a'.repeat(128), requestId: 'b'.repeat(128), reason: 'c'.repeat(128), error: 'd'.repeat(128) });
 const server = http.createServer((req, res) => hub.connect(res));
 server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const controller = new AbortController();
 const deadline = setTimeout(() => controller.abort(), 5000);
 try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let text = '', published = false;
  while (true) {
   const { value, done } = await reader.read(); assert.equal(done, false);
   text += decoder.decode(value, { stream: true });
   const frames = text.split('\n\n').slice(0, -1).filter(frame => frame.startsWith('id:'));
   if (frames.length >= 200 && !published) { published = true; hub.publish('info', 'live_probe', { index: 200 }); }
   if (frames.length >= 201 && text.includes(': keepalive\n\n')) {
    assert.equal(frames.length, 201);
    const rows = frames.map(frame => JSON.parse(frame.split('\ndata: ')[1]));
    assert.deepEqual(rows.map(row => row.index), Array.from({ length: 201 }, (_, i) => i));
    assert.equal(new Set(frames.map(frame => frame.split('\n')[0])).size, 201);
    await reader.cancel(); break;
   }
  }
 } finally {
  clearTimeout(deadline); controller.abort(); hub.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 }
});
