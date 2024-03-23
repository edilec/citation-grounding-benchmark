#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { benchmark, exitCodeFor, oneFinding, renderReport, validateLimits } from '../src/index.mjs'

const HELP = `citation-grounding-benchmark
Evaluate a human-labeled local claim/evidence fixture. An optional grader is a
supplied local JSON file, not a provider call or ground truth.

Usage: citation-grounding-benchmark --input FILE [--grader FILE] [--json] [limits]
  --input FILE       Human-labeled fixture (required)
  --grader FILE      Optional local grader results; never fetched or generated
  --json             Suppress the human summary on stderr
  --max-bytes N      Bytes per input file (default 4194304)
  --max-cases N      Cases in one fixture (default 2000)
  --max-evidence N   Evidence entries (default 5000)
  --max-depth N      JSON nesting depth (default 32)
  --max-findings N   Findings retained (default 1000)
  --timeout-ms N     Cooperative analysis deadline (default 30000; max 3600000)
  -h, --help         Show this help

Exit: 0 complete and clean; 1 complete with unsupported claims or disagreement;
2 invalid usage (empty stdout) or missing/invalid/limited evidence (incomplete
JSON report).
`

const FLAGS = new Map([
  ['--max-bytes', 'maxBytes'], ['--max-cases', 'maxCases'],
  ['--max-evidence', 'maxEvidence'], ['--max-depth', 'maxDepth'],
  ['--max-findings', 'maxFindings'], ['--timeout-ms', 'timeoutMs'],
])

function argumentsFor(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { input: null, grader: null, json: false, limits: {} }
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (arg === '--json') { options.json = true; continue }
    if (arg !== '--input' && arg !== '--grader' && !FLAGS.has(arg)) throw new Error('Unknown option')
    const value = argv[++at]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--input' || arg === '--grader') { options[arg.slice(2)] = value; continue }
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${arg} requires a positive integer`)
    }
    options.limits[FLAGS.get(arg)] = Number(value)
  }
  if (options.input === null) throw new Error('--input is required')
  validateLimits(options.limits)
  return options
}

async function localJson(path, maxBytes, tooLargeRule, unreadableRule, invalidRule) {
  const file = basename(path)
  let bytes
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('not a regular file')
    if (info.size > maxBytes) return { report: oneFinding(tooLargeRule, `Input exceeds the limit of ${maxBytes} bytes.`, file) }
    bytes = await readFile(path)
  } catch { return { report: oneFinding(unreadableRule, 'Local input could not be read as a regular file.', file) } }
  if (bytes.length > maxBytes) return { report: oneFinding(tooLargeRule, `Input exceeds the limit of ${maxBytes} bytes.`, file) }
  try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } }
  catch { return { report: oneFinding(invalidRule, 'Local input could not be decoded as UTF-8 JSON.', file) } }
}

async function main(argv) {
  let options
  try { options = argumentsFor(argv) }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2 }
  if (options.help) { process.stderr.write(HELP); return 0 }
  const limits = validateLimits(options.limits)
  const input = await localJson(options.input, limits.maxBytes, 'input-too-large', 'input-unreadable', 'input-invalid')
  let report = input.report
  let graderResults = null
  if (report === undefined && options.grader !== null) {
    const grader = await localJson(options.grader, limits.maxBytes, 'input-too-large', 'grader-unreadable', 'grader-invalid')
    report = grader.report
    if (report === undefined) graderResults = grader.value
  }
  if (report === undefined) {
    report = benchmark(input.value, {
      graderResults, limits: options.limits,
      file: basename(options.input), graderFile: options.grader === null ? 'grader.json' : basename(options.grader),
    })
  }
  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(`${report.tool}: status ${report.status}; ${report.summary.checked} case(s) checked.\n`)
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
