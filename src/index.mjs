import { performance } from 'node:perf_hooks'

export const TOOL_ID = 'citation-grounding-benchmark'
export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 4194304,
  maxCases: 2000,
  maxEvidence: 5000,
  maxDepth: 32,
  maxFindings: 1000,
  timeoutMs: 30000,
})

export const RULES = Object.freeze({
  'input-unreadable': { severity: 'error', incomplete: true },
  'grader-unreadable': { severity: 'error', incomplete: true },
  'input-invalid': { severity: 'error', incomplete: true },
  'input-too-large': { severity: 'error', incomplete: true },
  'depth-limit': { severity: 'error', incomplete: true },
  'case-limit': { severity: 'error', incomplete: true },
  'evidence-limit': { severity: 'error', incomplete: true },
  'findings-truncated': { severity: 'error', incomplete: true },
  'analysis-timeout': { severity: 'error', incomplete: true },
  'no-cases': { severity: 'error', incomplete: true },
  'evidence-invalid': { severity: 'error', incomplete: true },
  'evidence-duplicate': { severity: 'error', incomplete: true },
  'evidence-index-incomplete': { severity: 'error', incomplete: true },
  'case-invalid': { severity: 'error', incomplete: true },
  'case-duplicate': { severity: 'error', incomplete: true },
  'citation-missing': { severity: 'error', incomplete: true },
  'citation-orphan': { severity: 'error', incomplete: true },
  'human-uncertain': { severity: 'info', incomplete: true },
  'grader-invalid': { severity: 'error', incomplete: true },
  'grader-duplicate': { severity: 'error', incomplete: true },
  'grader-index-incomplete': { severity: 'error', incomplete: true },
  'grader-result-missing': { severity: 'error', incomplete: true },
  'unsupported-claim': { severity: 'error', incomplete: false },
  'grader-disagreement': { severity: 'error', incomplete: false },
  'numeric-signal-disagreement': { severity: 'info', incomplete: false },
})
for (const rule of Object.values(RULES)) Object.freeze(rule)

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError' }
}
class DeadlineError extends Error {}

const byCodeUnit = (a, b) => a === b ? 0 : a < b ? -1 : 1
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const label = (value) => value === 'supported' || value === 'unsupported' || value === 'uncertain'
const positive = (value) => Number.isSafeInteger(value) && value > 0
const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu
const visible = (value) => value.replace(invisible, '').trim()
const safe = (value) => String(value ?? '').replace(invisible, '').slice(0, 160)

export function validateLimits(overrides = {}) {
  if (overrides === null || Array.isArray(overrides) || typeof overrides !== 'object') {
    throw new ConfigError('limits must be an object')
  }
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${key}"`)
    if (!positive(value)) throw new ConfigError(`${key} must be a positive integer`)
    if (key === 'timeoutMs' && value > 3600000) throw new ConfigError('timeoutMs must be at most 3600000')
    limits[key] = value
  }
  return Object.freeze(limits)
}

function finding(ruleId, message, file, pointer = '', subject = '') {
  const rule = RULES[ruleId]
  if (rule === undefined) throw new TypeError(`Unknown ruleId "${ruleId}"`)
  return {
    ruleId, severity: rule.severity, message: safe(message),
    location: { file: safe(file) || 'cases.json', ...(pointer ? { pointer } : {}) },
    ...(subject ? { subject: safe(subject) } : {}),
  }
}

function reportOf(findings, results, file = 'cases.json') {
  const sorted = [...findings].sort((a, b) => byCodeUnit(a.subject ?? '', b.subject ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '') || byCodeUnit(a.ruleId, b.ruleId))
  const ordered = [...results].sort((a, b) => byCodeUnit(a.id, b.id))
  const errors = sorted.filter((item) => item.severity === 'error').length
  const warnings = sorted.filter((item) => item.severity === 'warning').length
  const info = sorted.filter((item) => item.severity === 'info').length
  const incomplete = sorted.some((item) => RULES[item.ruleId]?.incomplete)
  return {
    schemaVersion: '1', tool: TOOL_ID,
    status: incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    basis: { kind: 'human-labeled-local-fixture', graderIsGroundTruth: false,
      note: 'Human labels are supplied ground truth for this fixture. Deterministic checks and optional local grader results are separate signals, not proof of support.' },
    summary: {
      checked: ordered.length,
      supported: ordered.filter((item) => item.humanLabel === 'supported').length,
      unsupported: ordered.filter((item) => item.humanLabel === 'unsupported').length,
      uncertain: ordered.filter((item) => item.humanLabel === 'uncertain').length,
      errors, warnings, info,
    },
    results: ordered, findings: sorted,
  }
}

export function oneFinding(ruleId, message, file = 'cases.json') {
  return reportOf([finding(ruleId, message, file)], [], file)
}

function depthProblem(value, maxDepth, checkpoint) {
  const pending = [{ value, depth: 1, leave: false }]
  const active = new Set()
  while (pending.length) {
    checkpoint()
    const item = pending.pop()
    if (item.value === null || typeof item.value !== 'object') continue
    if (item.leave) { active.delete(item.value); continue }
    if (item.depth > maxDepth) return 'depth-limit'
    if (active.has(item.value)) return 'input-invalid'
    active.add(item.value)
    pending.push({ ...item, leave: true })
    let children
    try { children = Object.values(item.value) }
    catch { return 'input-invalid' }
    for (const child of children) pending.push({ value: child, depth: item.depth + 1, leave: false })
  }
  return null
}

function numbersIn(text) {
  return [...text.matchAll(/(?<![A-Za-z0-9])[-+]?\d+(?:\.\d+)?%?(?![A-Za-z0-9])/g)].map((match) => match[0])
}

export function benchmark(document, {
  graderResults = null, limits: overrides, now = () => performance.now(), file = 'cases.json', graderFile = 'grader.json',
} = {}) {
  const limits = validateLimits(overrides)
  if (typeof now !== 'function') throw new ConfigError('now must be a clock function')
  if (typeof file !== 'string' || typeof graderFile !== 'string') throw new ConfigError('file names must be strings')
  const started = now()
  if (!Number.isFinite(started)) throw new ConfigError('now must return a finite number')
  const checkpoint = () => {
    const current = now()
    if (!Number.isFinite(current)) throw new ConfigError('now must return a finite number')
    if (current - started > limits.timeoutMs) throw new DeadlineError()
  }
  const findings = []
  const results = []
  let truncated = false
  const add = (ruleId, message, pointer = '', subject = '', targetFile = file) => {
    if (findings.length >= limits.maxFindings) { truncated = true; return }
    findings.push(finding(ruleId, message, targetFile, pointer, subject))
  }
  const finish = () => {
    if (truncated) {
      findings.splice(limits.maxFindings - 1)
      findings.push(finding('findings-truncated', `More than ${limits.maxFindings} findings were present; later findings were not reported.`, file))
    }
    return reportOf(findings, results, file)
  }
  try {
    checkpoint()
    const depth = depthProblem(document, limits.maxDepth, checkpoint)
    if (depth !== null) { add(depth, depth === 'depth-limit' ? `Input exceeds depth limit ${limits.maxDepth}.` : 'Input contains a reference cycle.'); return finish() }
    if (document === null || typeof document !== 'object' || Array.isArray(document)
      || document.schemaVersion !== '1' || !Array.isArray(document.evidence) || !Array.isArray(document.cases)) {
      add('input-invalid', 'Input must be a version 1 object with evidence and cases arrays.')
      return finish()
    }
    if (document.evidence.length > limits.maxEvidence) { add('evidence-limit', `Evidence exceeds the limit of ${limits.maxEvidence} entries.`); return finish() }
    if (document.cases.length > limits.maxCases) { add('case-limit', `Cases exceed the limit of ${limits.maxCases} entries.`); return finish() }
    if (document.cases.length === 0) { add('no-cases', 'No human-labeled cases were supplied.'); return finish() }

    const evidence = new Map()
    let evidenceComplete = true
    for (const [at, entry] of document.evidence.entries()) {
      checkpoint()
      const text = entry !== null && typeof entry === 'object' && typeof entry.text === 'string'
        ? visible(entry.text) : ''
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
        || !identifier(entry.id) || text.length === 0) {
        evidenceComplete = false
        add('evidence-invalid', 'An evidence id or text is unusable, so the evidence index is incomplete.', `/evidence/${at}`)
        continue
      }
      if (evidence.has(entry.id)) {
        evidenceComplete = false
        add('evidence-duplicate', 'An evidence id is declared more than once, so its content is ambiguous.', `/evidence/${at}`, entry.id)
        continue
      }
      evidence.set(entry.id, text)
    }

    const graders = new Map()
    let graderComplete = true
    if (graderResults !== null) {
      const graderDepth = depthProblem(graderResults, limits.maxDepth, checkpoint)
      if (graderDepth === 'depth-limit') {
        add('depth-limit', `Local grader results exceed depth limit ${limits.maxDepth}.`, '', '', graderFile)
        graderComplete = false
      } else if (graderDepth !== null || graderResults === null || typeof graderResults !== 'object' || Array.isArray(graderResults)
        || graderResults.schemaVersion !== '1' || !Array.isArray(graderResults.results)) {
        add('grader-invalid', 'Local grader results are malformed.', '', '', graderFile)
        graderComplete = false
      } else if (graderResults.results.length > limits.maxCases) {
        add('case-limit', `Local grader results exceed case limit ${limits.maxCases}.`, '', '', graderFile)
        graderComplete = false
      } else {
        for (const [at, item] of graderResults.results.entries()) {
          checkpoint()
          if (item === null || typeof item !== 'object' || Array.isArray(item) || !identifier(item.caseId) || !label(item.label)) {
            graderComplete = false
            add('grader-invalid', 'Local grader result has an unusable case id or label.', `/results/${at}`, '', graderFile)
            continue
          }
          if (graders.has(item.caseId)) {
            graderComplete = false
            add('grader-duplicate', 'A case has more than one local grader result.', `/results/${at}`, item.caseId, graderFile)
            continue
          }
          graders.set(item.caseId, item.label)
        }
      }
    }

    const caseIds = new Set()
    for (const [at, item] of document.cases.entries()) {
      checkpoint()
      const pointer = `/cases/${at}`
      const claim = item !== null && typeof item === 'object' && typeof item.claim === 'string'
        ? visible(item.claim) : ''
      if (item === null || typeof item !== 'object' || Array.isArray(item)
        || !identifier(item.id) || claim.length === 0 || !label(item.humanLabel)) {
        add('case-invalid', 'Case id, claim or human label is unusable.', pointer)
        continue
      }
      if (caseIds.has(item.id)) { add('case-duplicate', 'Case id is declared more than once.', pointer, item.id); continue }
      caseIds.add(item.id)
      const result = { id: item.id, humanLabel: item.humanLabel, deterministicOutcome: 'uncertain' }
      results.push(result)
      if (item.humanLabel === 'unsupported') add('unsupported-claim', 'Human label marks this claim unsupported.', pointer, item.id)
      if (item.humanLabel === 'uncertain') add('human-uncertain', 'Human label is uncertain; this case is not a supported result.', pointer, item.id)

      let citedTexts = null
      if (!Array.isArray(item.citationIds) || item.citationIds.length === 0
        || item.citationIds.some((id) => !identifier(id))) {
        add('citation-missing', 'Citation ids are missing or unusable, so grounding was not evaluated.', pointer, item.id)
      } else if (!evidenceComplete) {
        add('evidence-index-incomplete', 'Evidence index dropped an entry; cited membership and numbers are unknown.', pointer, item.id)
      } else {
        citedTexts = item.citationIds.map((id) => evidence.get(id))
        if (citedTexts.some((text) => text === undefined)) {
          add('citation-orphan', 'Citation id is absent from the complete evidence index.', pointer, item.id)
          citedTexts = null
        }
      }
      if (citedTexts !== null) {
        const claimed = numbersIn(claim)
        const cited = new Set(citedTexts.flatMap(numbersIn))
        if (claimed.length > 0 && cited.size > 0 && claimed.some((value) => !cited.has(value))) {
          result.deterministicOutcome = 'unsupported'
          if (item.humanLabel === 'supported') {
            add('numeric-signal-disagreement', 'A claimed number is absent from cited numeric tokens, but the human label says supported; review this signal.', pointer, item.id)
          }
        }
      }

      if (graderResults !== null) {
        if (!graderComplete) add('grader-index-incomplete', 'Local grader index is incomplete; no grader comparison was made.', pointer, item.id, graderFile)
        else if (!graders.has(item.id)) add('grader-result-missing', 'No local grader result was supplied for this case.', pointer, item.id, graderFile)
        else {
          result.graderOutcome = graders.get(item.id)
          result.graderBasis = 'local-supplied-result'
          if (result.graderOutcome !== item.humanLabel) {
            add('grader-disagreement', 'Local grader label differs from the human label; the grader is not ground truth.', pointer, item.id, graderFile)
          }
        }
      }
    }
    checkpoint()
    return finish()
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error
    return oneFinding('analysis-timeout', `Analysis exceeded the cooperative limit of ${limits.timeoutMs} milliseconds.`, file)
  }
}

export function exitCodeFor(report) { return report.status === 'incomplete' ? 2 : report.status === 'fail' ? 1 : 0 }
export function renderReport(report) { return `${JSON.stringify(report, null, 2)}\n` }
