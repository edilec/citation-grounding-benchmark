import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'citation-grounding-benchmark.mjs')
const CASES = { schemaVersion: '1',
  evidence: [{ id: 'e1', text: 'The study enrolled 20 volunteers.' }],
  cases: [{ id: 'case-1', claim: 'The study enrolled 20 volunteers.', citationIds: ['e1'], humanLabel: 'supported' }],
}
const GRADER = { schemaVersion: '1', results: [{ caseId: 'case-1', label: 'unsupported' }] }

async function fixture(t, data = CASES, grader = GRADER) {
  const root = await mkdtemp(join(tmpdir(), 'cgb-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'cases.json')
  const graderFile = join(root, 'grader.json')
  const content = typeof data === 'string' ? data : `${JSON.stringify(data)}\n`
  await writeFile(input, content)
  await writeFile(graderFile, typeof grader === 'string' ? grader : `${JSON.stringify(grader)}\n`)
  return { root, input, graderFile, bytes: Buffer.byteLength(content) }
}

function run(args) {
  return new Promise((done) => execFile(process.execPath, [CLI, ...args], { maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => done({ code: error === null ? 0 : error.code ?? 1, stdout, stderr })))
}

test('CLI evaluates a supported fixture offline with no grader by default', async (t) => {
  const { input } = await fixture(t)
  const result = await run(['--input', input, '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.results[0].deterministicOutcome, 'uncertain')
  assert.equal(report.results[0].graderOutcome, undefined)
})

test('a local grader file disagreement fails without changing the human label', async (t) => {
  const { input, graderFile } = await fixture(t)
  const result = await run(['--input', input, '--grader', graderFile, '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['grader-disagreement'])
  assert.equal(report.results[0].humanLabel, 'supported')
  assert.equal(report.results[0].graderOutcome, 'unsupported')
  assert.equal(report.basis.graderIsGroundTruth, false)
})

test('unknown option is configuration exit 2 with empty stdout; missing input is incomplete', async (t) => {
  const { input, root } = await fixture(t)
  const invalid = await run(['--input', input, '--grader-model', 'anything'])
  assert.equal(invalid.code, 2)
  assert.equal(invalid.stdout, '')
  assert.match(invalid.stderr, /Unknown option/)
  const missing = await run(['--input', join(root, 'gone.json'), '--json'])
  assert.equal(missing.code, 2)
  assert.equal(JSON.parse(missing.stdout).findings[0].ruleId, 'input-unreadable')
})

test('unreadable optional grader is incomplete, not silently skipped', async (t) => {
  const { input, root } = await fixture(t)
  const result = await run(['--input', input, '--grader', join(root, 'gone.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['grader-unreadable'])
  assert.equal(report.status, 'incomplete')
})

test('invalid JSON does not echo a synthetic credential canary', async (t) => {
  const { input } = await fixture(t, '{"token": AKIAIOSFODNN7EXAMPLE}')
  const result = await run(['--input', input, '--json'])
  assert.equal(result.code, 2)
  assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'input-invalid')
  assert.ok(!result.stdout.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.ok(!result.stderr.includes('AKIAIOSFODNN7EXAMPLE'))
})

test('maxBytes accepts exactly N and reports N+1 as incomplete', async (t) => {
  const { input, bytes } = await fixture(t)
  const at = await run(['--input', input, '--max-bytes', String(bytes), '--json'])
  assert.equal(at.code, 0)
  const over = await run(['--input', input, '--max-bytes', String(bytes - 1), '--json'])
  assert.equal(over.code, 2)
  assert.deepEqual(JSON.parse(over.stdout).findings.map((finding) => finding.ruleId), ['input-too-large'])
})

test('optional grader bytes accept exactly N and refuse N+1', async (t) => {
  const { input, graderFile } = await fixture(t)
  const largeGrader = { ...GRADER, note: 'x'.repeat(512) }
  const graderText = `${JSON.stringify(largeGrader)}\n`
  await writeFile(graderFile, graderText)
  const graderBytes = Buffer.byteLength(graderText)
  const at = await run(['--input', input, '--grader', graderFile,
    '--max-bytes', String(graderBytes), '--json'])
  assert.equal(at.code, 1)
  assert.deepEqual(JSON.parse(at.stdout).findings.map((finding) => finding.ruleId), ['grader-disagreement'])
  const over = await run(['--input', input, '--grader', graderFile,
    '--max-bytes', String(graderBytes - 1), '--json'])
  assert.equal(over.code, 2)
  assert.deepEqual(JSON.parse(over.stdout).findings.map((finding) => finding.ruleId), ['input-too-large'])
})

test('strict UTF-8 and a malformed local grader produce incomplete reports', async (t) => {
  const { input, graderFile } = await fixture(t)
  await writeFile(graderFile, Buffer.from([0xff]))
  const grader = await run(['--input', input, '--grader', graderFile, '--json'])
  assert.equal(grader.code, 2)
  assert.deepEqual(JSON.parse(grader.stdout).findings.map((finding) => finding.ruleId), ['grader-invalid'])
  await writeFile(input, Buffer.from([0xff]))
  const source = await run(['--input', input, '--json'])
  assert.equal(source.code, 2)
  assert.deepEqual(JSON.parse(source.stdout).findings.map((finding) => finding.ruleId), ['input-invalid'])
})

test('byte-identical input yields byte-identical stdout', async (t) => {
  const { input } = await fixture(t)
  const first = await run(['--input', input, '--json'])
  const second = await run(['--input', input, '--json'])
  assert.equal(first.code, 0)
  assert.equal(second.code, 0)
  assert.equal(first.stdout, second.stdout)
})

test('untrusted option text does not write bidi controls to diagnostics', async (t) => {
  const { input } = await fixture(t)
  const result = await run(['--input', input, '--bogus\u202eoption'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option/)
  assert.ok(!result.stderr.includes('\u202e'))
})

test('duplicate case JSON keys cannot erase an earlier human label', async (t) => {
  const ordinary = JSON.stringify(CASES)
  const duplicate = ordinary.replace('"humanLabel":"supported"',
    '"humanLabel":"unsupported","humanLabel":"supported"')
  assert.notEqual(duplicate, ordinary)
  const { input } = await fixture(t, duplicate)
  const result = await run(['--input', input, '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['input-invalid'])
})

test('duplicate local grader keys are incomplete, not a last-wins pass', async (t) => {
  const ordinary = JSON.stringify(GRADER)
  const duplicate = ordinary.replace('"label":"unsupported"',
    '"label":"unsupported","label":"supported"')
  assert.notEqual(duplicate, ordinary)
  const { input, graderFile } = await fixture(t, CASES, duplicate)
  const result = await run(['--input', input, '--grader', graderFile, '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['grader-invalid'])
})

test('key-like text inside a claim and repeated names in separate records remain valid', async (t) => {
  const text = '{"humanLabel":"unsupported","humanLabel":"supported"}'
  const input = { schemaVersion: '1', evidence: [
    { id: 'e1', text }, { id: 'e2', text: 'Another record.' },
  ], cases: [{ id: 'case-1', claim: text, citationIds: ['e1'], humanLabel: 'supported' }] }
  const { input: file } = await fixture(t, input)
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})
