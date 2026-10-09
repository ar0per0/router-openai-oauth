import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { createRouterServer } from '../src/server.mjs'

const listen = async server => {
 server.listen(0, '127.0.0.1'); await once(server, 'listening')
 return `http://127.0.0.1:${server.address().port}`
}
const close = async server => {
 server.closeAllConnections()
 if (server.listening) await new Promise(resolve => server.close(resolve))
}
const legacyEnvironment = {
 STARTUP_HEALTHCHECK_ENABLED: 'true', STARTUP_HEALTHCHECK_TIMEOUT_MS: 'invalid',
 STARTUP_HEALTHCHECK_MODEL: 'invalid model',
}

test('config retires startup knobs, preserving runtime defaults even with legacy values', () => {
 const defaults = loadConfig({})
 assert.deepEqual(loadConfig(legacyEnvironment), defaults)
 assert.ok(!Object.keys(defaults).some(key => key.startsWith('startup')))
 assert.equal(defaults.upstreamFailureThreshold, 3)
 assert.equal(defaults.clientErrorFailureThreshold, 5)
 assert.equal(defaults.upstreamTimeoutMs, 180000)
 assert.equal(defaults.upstreamCooldownMs, 600000)
 assert.equal(defaults.runtimeFailover, false)
})

test('router listener and readonly health/status make zero upstream requests; runtime remains on demand', async t => {
 const paths = []
 const upstream = http.createServer((req, res) => {
  paths.push(req.url)
  res.setHeader('content-type', 'application/json')
  res.end(req.url === '/oauth/rate-limits' ? JSON.stringify({rateLimits:null}) : '{"ok":true}')
 })
 t.after(() => close(upstream))
 const upstreamUrl = await listen(upstream)
 const router = createRouterServer(loadConfig({UPSTREAMS:upstreamUrl, ...legacyEnvironment}))
 t.after(() => close(router))
 const base = await listen(router)
 assert.deepEqual(await (await fetch(base+'/health')).json(), {status:'ok',upstreams:1})
 const status = await (await fetch(base+'/router/status')).json()
 assert.equal(status.upstreams[0].state, 'closed')
 assert.equal(status.upstreams[0].failures, 0)
 assert.equal(status.upstreams[0].clientErrors, 0)
 assert.equal(status.upstreams[0].probeInFlight, false)
 await new Promise(resolve => setTimeout(resolve, 50))
 assert.deepEqual(paths, []) // Includes models, responses, chat and quota routes.
 const response = await fetch(base+'/v1/responses', {method:'POST',body:'{}'})
 assert.equal(response.status, 200); await response.arrayBuffer()
 assert.deepEqual(paths, ['/oauth/rate-limits','/v1/responses'])
})

test('real index entrypoint starts without models/inference/quota calls or startup validation logs', {timeout:10000}, async t => {
 const paths = []
 const upstream = http.createServer((req, res) => {paths.push(req.url);res.writeHead(500);res.end()})
 t.after(() => close(upstream))
 const upstreamUrl = await listen(upstream)
 // Reserve an ephemeral loopback port, release it immediately before spawning.
 const reservation = http.createServer()
 await listen(reservation)
 const port = reservation.address().port
 await close(reservation)
 const directory = await mkdtemp(join(tmpdir(), 'router-startup-'))
 t.after(() => rm(directory, {recursive:true,force:true}))
 // Deliberately do not inherit credentials or the operator's environment.
 const child = spawn(process.execPath, ['src/index.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {HOST:'127.0.0.1',PORT:String(port),UPSTREAMS:upstreamUrl,
   USAGE_DB_PATH:join(directory,'usage.sqlite'), ...legacyEnvironment},
  stdio:['ignore','pipe','pipe'],
 })
 const exited = once(child, 'exit')
 t.after(async () => {if(child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');await exited})
 let output = '', stderr = ''
 child.stderr.on('data', chunk => {stderr += chunk})
 await new Promise((resolve, reject) => {
  child.stdout.on('data', chunk => {output += chunk;if(output.includes('server_started')) resolve()})
  child.once('error', reject)
  child.once('exit', code => reject(new Error(`entrypoint exited ${code}: ${stderr}`)))
 })
 assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200)
 const status = await (await fetch(`http://127.0.0.1:${port}/router/status`)).json()
 assert.equal(status.upstreams[0].state, 'closed')
 await new Promise(resolve => setTimeout(resolve, 50))
 assert.deepEqual(paths, [])
 assert.doesNotMatch(output, /startupHealthcheck|upstream_healthcheck|upstream_initial/)
 child.kill('SIGTERM')
 const [code, signal] = await exited
 assert.equal(code, 0); assert.equal(signal, null)
})

test('occupied listener exits nonzero and closes SQLite worker without signal', {timeout:10000},async t=>{
 const blocker=http.createServer();await listen(blocker);t.after(()=>close(blocker));
 const directory=await mkdtemp(join(tmpdir(),'router-bind-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const child=spawn(process.execPath,['src/index.mjs'],{cwd:new URL('..',import.meta.url),env:{HOST:'127.0.0.1',PORT:String(blocker.address().port),USAGE_DB_PATH:join(directory,'usage.sqlite')},stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});let output='';child.stdout.on('data',x=>output+=x);child.stderr.resume();
 const [code,signal]=await once(child,'exit');assert.equal(code,1);assert.equal(signal,null);assert.match(output,/server_error/);assert.doesNotMatch(output,/server_started/);
 const docker=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../Dockerfile',import.meta.url),'utf8'));assert.doesNotMatch(docker,/STARTUP_HEALTHCHECK_/);
});
