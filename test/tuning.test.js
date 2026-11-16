import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { headroomFor, routePolicy, engineConfig, DEFAULTS, SUMMARY_CAP } from '../lib/tuning.js'

const run = (cmd, args) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.on('exit', () => resolve(out))
})

test('headroom is a fraction of the route, clamped into the band', () => {
  assert.equal(headroomFor(128000, 32000), 4000) // the value ptc ships today
  assert.equal(headroomFor(32000, 8000), 1000)
  assert.equal(headroomFor(24000, 8000), 750)
  assert.equal(headroomFor(1000000, 32000), SUMMARY_CAP) // past the summary cap the buffer buys nothing
})

test('a route policy is exact-match and capped', () => {
  assert.deepEqual(routePolicy('strata', 'strata', 128000, 32000),
    { provider: 'strata', model: 'strata', headroomTokens: 4000, maxTokens: 4000 })
  assert.deepEqual(routePolicy('llama', 'qwen3.8-27b-iq3_xxs', 32000, 8000),
    { provider: 'llama', model: 'qwen3.8-27b-iq3_xxs', headroomTokens: 1000, maxTokens: 1000 })
})

test('row config wins over the tuning defaults and unknown keys never reach the backend', () => {
  const merged = engineConfig(
    { retainTokens: 20000, summarizationModel: 'x', vcc: {} },
    DEFAULTS,
  )
  // Defaults reach the backend even when the row declares nothing; `vcc` must not.
  assert.deepEqual(merged, {
    thresholdRatio: 0.85,
    headroomTokens: 1000,
    retainTokens: 20000,
    auto: true,
    summarizationModel: 'x',
  })
})

test('the installed compaction-basic engine accepts the refreshed config and still rejects the stock default', async () => {
  const store = process.env.DSH_PNPM_GLOBAL ?? `${process.env.HOME}/.local/share/pnpm/global`
  const engineFile = (await run('find', [store, '-maxdepth', '14', '-name', 'index.js', '-path', '*dsh-compaction-basic*']))
    .split('\n').find((line) => line.trim() !== '')
  assert.ok(engineFile, `no installed dsh-compaction-basic index.js under ${store}`)
  const src = await readFile(engineFile.trim(), 'utf8')
  const regionStart = src.indexOf('//#region lib/types/config.js')
  const region = src.slice(regionStart, src.indexOf('//#endregion', regionStart + 1))

  const refreshed = engineConfig({}, DEFAULTS)
  refreshed.modelPolicies = [routePolicy('strata', 'strata', 128000, 32000)]
  const probes = [
    { provider: 'strata', model: 'strata', window: 128000, reservation: 32000 },
    { provider: 'unknown', model: 'unknown', window: 32000, reservation: 8000 }, // unseen route: global headroom
    { provider: 'unknown', model: 'unknown', window: 1000000, reservation: 32000 },
  ]
  const dir = await mkdtemp(`${tmpdir()}/dsh-vcc-test-`)
  try {
    await writeFile(`${dir}/engine.mjs`, `const deepFreeze = (value) => value\n${region}\nexport { resolveConfig, resolveTargetPolicy, resolveCompactSpec }\n`)
    await writeFile(`${dir}/driver.mjs`, [
      `import { resolveConfig, resolveTargetPolicy, resolveCompactSpec } from './engine.mjs'`,
      `const cfg = ${JSON.stringify(refreshed)}`,
      `const probes = ${JSON.stringify(probes)}`,
      `const resolved = resolveConfig(cfg)`,
      `const failures = []`,
      `const spec = resolveCompactSpec(resolveTargetPolicy(resolved, { provider: 'strata', model: 'strata' }), 128000, 32000)`,
      `if (spec.thresholdTokens !== 92000) failures.push(\`strata trigger is \${spec.thresholdTokens}, expected 92000\`)`,
      `if (spec.retainTokens !== 16000) failures.push(\`retainTokens is \${spec.retainTokens}, expected the default 16000\`)`,
      `for (const probe of probes) {`,
      `  try { resolveCompactSpec(resolveTargetPolicy(resolved, probe), probe.window, probe.reservation) }`,
      `  catch (e) { failures.push(\`\${probe.provider}/\${probe.model} \${probe.window}/\${probe.reservation}: \${e.message}\`) }`,
      `}`,
      `const stockThrows = (() => { try { resolveCompactSpec(resolveTargetPolicy(resolveConfig({ auto: true }), { provider: 'x', model: 'y' }), 24000, 8000); return false } catch { return true } })()`,
      `console.log(JSON.stringify({ ok: failures.length === 0, failures, stockThrows }))`,
    ].join('\n'))
    const report = JSON.parse(await run('node', [`${dir}/driver.mjs`]))
    assert.equal(report.ok, true, report.failures.join('; '))
    assert.equal(report.stockThrows, true, 'stock default should still throw on a 24k route')
  } finally {
    await rm(dir, { recursive: true })
  }
})
