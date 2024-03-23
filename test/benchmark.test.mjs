import assert from 'node:assert/strict'
import test from 'node:test'
import * as tool from '../src/index.mjs'

function fixture() {
  return {
    schemaVersion: '1',
    evidence: [{ id: 'e1', text: 'The study enrolled 20 volunteers.' }],
    cases: [{ id: 'case-1', claim: 'The study enrolled 20 volunteers.',
      citationIds: ['e1'], humanLabel: 'supported' }],
  }
}

const ids = (report) => report.findings.map((finding) => finding.ruleId)

test('a human-supported, numerically consistent case passes without claiming deterministic support', () => {
  assert.equal(typeof tool.benchmark, 'function')
  const report = tool.benchmark(fixture())
  assert.equal(report.tool, 'citation-grounding-benchmark')
  assert.equal(report.status, 'pass')
  assert.deepEqual(ids(report), [])
  assert.equal(report.summary.supported, 1)
  assert.equal(report.results[0].humanLabel, 'supported')
  assert.equal(report.results[0].deterministicOutcome, 'uncertain')
})

test('a human-unsupported numerical claim is caught against cited numbers', () => {
  const input = fixture()
  input.cases[0].claim = 'The study enrolled 25 volunteers.'
  input.cases[0].humanLabel = 'unsupported'
  const report = tool.benchmark(input)
  assert.equal(report.status, 'fail')
  assert.ok(ids(report).includes('unsupported-claim'))
  assert.equal(report.results[0].humanLabel, 'unsupported')
  assert.equal(report.results[0].deterministicOutcome, 'unsupported')
  assert.equal(report.summary.unsupported, 1)
})

test('citation presence alone does not yield deterministic support', () => {
  const input = fixture()
  input.cases[0].claim = 'Cats sleep.'
  const report = tool.benchmark(input)
  assert.equal(report.results[0].humanLabel, 'supported')
  assert.equal(report.results[0].deterministicOutcome, 'uncertain')
  assert.ok(!ids(report).includes('unsupported-claim'))
})

test('a local grader disagreement is reported separately from the human label', () => {
  const report = tool.benchmark(fixture(), {
    graderResults: { schemaVersion: '1', results: [{ caseId: 'case-1', label: 'unsupported' }] },
  })
  assert.equal(report.status, 'fail')
  assert.deepEqual(ids(report), ['grader-disagreement'])
  assert.deepEqual(report.results[0], {
    id: 'case-1', humanLabel: 'supported', deterministicOutcome: 'uncertain',
    graderOutcome: 'unsupported', graderBasis: 'local-supplied-result',
  })
})

test('a holed evidence index cannot positively call a citation orphan or a claim unsupported', () => {
  const input = fixture()
  input.evidence.push({ id: 'broken', text: null })
  input.cases[0].citationIds = ['missing']
  input.cases[0].claim = 'The study enrolled 25 volunteers.'
  const report = tool.benchmark(input)
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('evidence-index-incomplete'))
  assert.ok(!ids(report).includes('citation-orphan'))
  assert.equal(report.results[0].deterministicOutcome, 'uncertain')
})

test('a missing citation in a complete index is incomplete, not an unsupported inference', () => {
  const input = fixture()
  input.cases[0].citationIds = ['missing']
  const report = tool.benchmark(input)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['citation-orphan'])
  assert.equal(report.results[0].deterministicOutcome, 'uncertain')
})

test('an uncertain human label stays uncertain and prevents a vacuous pass', () => {
  const input = fixture()
  input.cases[0].humanLabel = 'uncertain'
  const report = tool.benchmark(input)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['human-uncertain'])
  assert.equal(report.summary.uncertain, 1)
})

test('maxCases is silent at N and incomplete at N+1', () => {
  const input = fixture()
  assert.equal(tool.benchmark(input, { limits: { maxCases: 1 } }).status, 'pass')
  input.cases.push({ ...input.cases[0], id: 'case-2' })
  const over = tool.benchmark(input, { limits: { maxCases: 1 } })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(ids(over), ['case-limit'])
})

test('maxDepth is silent at N and incomplete at N+1', () => {
  const input = fixture()
  // The citationIds array is a fourth nested container.
  assert.equal(tool.benchmark(input, { limits: { maxDepth: 4 } }).status, 'pass')
  const over = tool.benchmark(input, { limits: { maxDepth: 3 } })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(ids(over), ['depth-limit'])
})

test('the injected clock accepts exactly N and returns incomplete at N+1', () => {
  let calls = 0
  const at = tool.benchmark(fixture(), { limits: { timeoutMs: 5 }, now: () => calls++ === 0 ? 100 : 105 })
  assert.equal(at.status, 'pass')
  calls = 0
  const over = tool.benchmark(fixture(), { limits: { timeoutMs: 5 }, now: () => calls++ === 0 ? 100 : 106 })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(ids(over), ['analysis-timeout'])
  assert.deepEqual(over.results, [])
})

test('case findings sort by code unit, not input or locale order', () => {
  const input = fixture()
  input.cases = [
    { ...input.cases[0], id: 'a', humanLabel: 'unsupported' },
    { ...input.cases[0], id: 'Z', humanLabel: 'unsupported' },
  ]
  assert.deepEqual(tool.benchmark(input).findings.map((finding) => finding.subject), ['Z', 'a'])
})

test('maxEvidence is silent at N and incomplete at N+1', () => {
  const input = fixture()
  assert.equal(tool.benchmark(input, { limits: { maxEvidence: 1 } }).status, 'pass')
  input.evidence.push({ id: 'e2', text: 'Another local sentence.' })
  const over = tool.benchmark(input, { limits: { maxEvidence: 1 } })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(ids(over), ['evidence-limit'])
})

test('maxFindings is silent at N and N+1 stays incomplete without exceeding the bound', () => {
  const input = fixture()
  input.cases[0].humanLabel = 'unsupported'
  const at = tool.benchmark(input, { limits: { maxFindings: 1 } })
  assert.equal(at.status, 'fail')
  assert.deepEqual(ids(at), ['unsupported-claim'])
  input.cases[0].citationIds = []
  const over = tool.benchmark(input, { limits: { maxFindings: 1 } })
  assert.equal(over.status, 'incomplete')
  assert.equal(over.findings.length, 1)
  assert.deepEqual(ids(over), ['findings-truncated'])
})

test('no cases and absent citations cannot pass vacuously', () => {
  const input = fixture()
  input.cases = []
  const empty = tool.benchmark(input)
  assert.equal(empty.status, 'incomplete')
  assert.deepEqual(ids(empty), ['no-cases'])
  input.cases = fixture().cases
  input.cases[0].citationIds = []
  const report = tool.benchmark(input)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['citation-missing'])
})

test('invalid evidence text is unknown on the index side, not a positive orphan', () => {
  const input = fixture()
  input.evidence[0].text = null
  const report = tool.benchmark(input)
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('evidence-invalid'))
  assert.ok(ids(report).includes('evidence-index-incomplete'))
  assert.ok(!ids(report).includes('citation-orphan'))
  assert.equal(report.results[0].deterministicOutcome, 'uncertain')
})

test('incomplete local grader index cannot assert a positive disagreement', () => {
  const report = tool.benchmark(fixture(), { graderResults: {
    schemaVersion: '1', results: [
      { caseId: 'case-1', label: 'unsupported' },
      { caseId: 'broken', label: 'other' },
    ],
  } })
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('grader-invalid'))
  assert.ok(ids(report).includes('grader-index-incomplete'))
  assert.ok(!ids(report).includes('grader-disagreement'))
  assert.equal(report.results[0].graderOutcome, undefined)
})

test('numeric discrepancy with a supported human label is a separate signal, not a truth assertion', () => {
  const input = fixture()
  input.cases[0].claim = 'The study enrolled 25 volunteers.'
  const report = tool.benchmark(input)
  assert.equal(report.results[0].humanLabel, 'supported')
  assert.equal(report.results[0].deterministicOutcome, 'unsupported')
  assert.deepEqual(ids(report), ['numeric-signal-disagreement'])
  assert.equal(report.findings[0].severity, 'info')
  assert.ok(!ids(report).includes('unsupported-claim'))
})

test('claim rendered empty after control stripping is invalid and does not pass', () => {
  const input = fixture()
  input.cases[0].claim = '\u0001\u0085\u200e\u2028\u2029\u202e'
  const report = tool.benchmark(input)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['case-invalid'])
  assert.equal(report.summary.checked, 0)
})

test('grader case limit accepts N and refuses N+1 without comparing partial results', () => {
  const input = fixture()
  const at = tool.benchmark(input, { limits: { maxCases: 1 }, graderResults: {
    schemaVersion: '1', results: [{ caseId: 'case-1', label: 'supported' }],
  } })
  assert.equal(at.status, 'pass')
  assert.equal(at.results[0].graderOutcome, 'supported')
  const over = tool.benchmark(input, { limits: { maxCases: 1 }, graderResults: {
    schemaVersion: '1', results: [
      { caseId: 'case-1', label: 'unsupported' },
      { caseId: 'case-2', label: 'unsupported' },
    ],
  } })
  assert.equal(over.status, 'incomplete')
  assert.ok(ids(over).includes('case-limit'))
  assert.ok(ids(over).includes('grader-index-incomplete'))
  assert.ok(!ids(over).includes('grader-disagreement'))
})

test('grader depth accepts N and refuses N+1 without using surviving labels', () => {
  const grader = { schemaVersion: '1', results: [
    { caseId: 'case-1', label: 'supported', extra: { nested: true } },
  ] }
  assert.equal(tool.benchmark(fixture(), { limits: { maxDepth: 4 }, graderResults: grader }).status, 'pass')
  grader.results[0].extra.nested = { deeper: true }
  const over = tool.benchmark(fixture(), { limits: { maxDepth: 4 }, graderResults: grader })
  assert.equal(over.status, 'incomplete')
  assert.ok(ids(over).includes('depth-limit'))
  assert.ok(ids(over).includes('grader-index-incomplete'))
})

test('a complete grader index with a missing result is incomplete, not an implicit pass', () => {
  const report = tool.benchmark(fixture(), { graderResults: { schemaVersion: '1', results: [] } })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['grader-result-missing'])
  assert.equal(report.results[0].graderOutcome, undefined)
})

test('duplicate evidence and grader ids refuse ambiguous comparison', () => {
  const input = fixture()
  input.evidence.push({ id: 'e1', text: 'The study enrolled 25 volunteers.' })
  const graderResults = { schemaVersion: '1', results: [
    { caseId: 'case-1', label: 'supported' }, { caseId: 'case-1', label: 'unsupported' },
  ] }
  const report = tool.benchmark(input, { graderResults })
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('evidence-duplicate'))
  assert.ok(ids(report).includes('evidence-index-incomplete'))
  assert.ok(ids(report).includes('grader-duplicate'))
  assert.ok(ids(report).includes('grader-index-incomplete'))
  assert.equal(report.results[0].graderOutcome, undefined)
  assert.equal(report.results[0].deterministicOutcome, 'uncertain')
})

test('rule catalog is frozen with no undocumented severity or incompleteness drift', () => {
  const expected = {
    'input-unreadable': ['error', true], 'grader-unreadable': ['error', true],
    'input-invalid': ['error', true], 'input-too-large': ['error', true],
    'depth-limit': ['error', true], 'case-limit': ['error', true],
    'evidence-limit': ['error', true], 'findings-truncated': ['error', true],
    'analysis-timeout': ['error', true], 'no-cases': ['error', true],
    'evidence-invalid': ['error', true], 'evidence-duplicate': ['error', true],
    'evidence-index-incomplete': ['error', true], 'case-invalid': ['error', true],
    'case-duplicate': ['error', true], 'citation-missing': ['error', true],
    'citation-orphan': ['error', true], 'human-uncertain': ['info', true],
    'grader-invalid': ['error', true], 'grader-duplicate': ['error', true],
    'grader-index-incomplete': ['error', true], 'grader-result-missing': ['error', true],
    'unsupported-claim': ['error', false], 'grader-disagreement': ['error', false],
    'numeric-signal-disagreement': ['info', false],
  }
  assert.deepEqual(Object.fromEntries(Object.entries(tool.RULES).map(([id, rule]) => [id,
    [rule.severity, rule.incomplete]])), expected)
  assert.ok(Object.isFrozen(tool.RULES))
  for (const rule of Object.values(tool.RULES)) assert.ok(Object.isFrozen(rule))
})

test('configuration timeout ceiling accepts N and rejects N+1 and unknown keys', () => {
  assert.equal(tool.validateLimits({ timeoutMs: 3600000 }).timeoutMs, 3600000)
  assert.throws(() => tool.validateLimits({ timeoutMs: 3600001 }), tool.ConfigError)
  assert.throws(() => tool.validateLimits({ maxCase: 1 }), tool.ConfigError)
})
