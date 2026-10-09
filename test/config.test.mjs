import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "../src/config.mjs"

test("usage default local absoluto y override opcional compatible", () => {
	assert.equal(loadConfig({}).usageDbPath, resolve(process.cwd(), "data/usage.sqlite"))
	assert.equal(loadConfig({ USAGE_DB_PATH: "" }).usageDbPath, loadConfig({}).usageDbPath)
	for (const path of ["/custom/usage.sqlite", "./custom/usage.sqlite"]) {
		assert.equal(loadConfig({ USAGE_DB_PATH: path }).usageDbPath, path)
	}
})

test("Docker sin USAGE_DB_PATH conserva el archivo del volumen durable", (t) => {
	const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")
	const compose = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8")
	const workdir = /^WORKDIR (.+)$/m.exec(dockerfile)?.[1]
	assert.equal(workdir, "/app")
	assert.doesNotMatch(dockerfile, /USAGE_DB_PATH/)
	assert.doesNotMatch(compose, /USAGE_DB_PATH/)
	assert.match(compose, /- router-usage:\/app\/data\s/)
	assert.match(compose, /^volumes:\s*\n  router-usage:/m)
	t.mock.method(process, "cwd", () => workdir)
	assert.equal(loadConfig({}).usageDbPath, "/app/data/usage.sqlite")
})
