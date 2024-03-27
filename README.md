# Citation Grounding Benchmark

Benchmark human-labeled answer claims against cited, locally exported evidence.
The tool keeps three things separate: the supplied human label, a deliberately
narrow deterministic numerical signal, and an optional **locally supplied**
grader label. A citation's mere presence never proves a claim supported.

## Quick start

Node 22 or later; no runtime or development dependencies.

```sh
node bin/citation-grounding-benchmark.mjs --input examples/supported.json --json
node bin/citation-grounding-benchmark.mjs --input examples/unsupported.json --json
node bin/citation-grounding-benchmark.mjs --input examples/supported.json --grader examples/grader-disagrees.json --json
npm run check
```

The first example passes (exit 0). The unsupported fixture and the local grader
disagreement fail (exit 1). `examples/missing-citation.json` is incomplete
(exit 2). The CLI writes only the JSON report to stdout. Without `--json`, a
short operational summary goes to stderr. It reads files, but writes no files
and never calls a model, provider, database, browser or network service.

## Fixture contract

One UTF-8 JSON file contains a version, exported evidence text and human-labeled
cases. IDs are ASCII letters/digits followed by letters/digits, `.`, `_`, `:`
or `-`. Each case has at least one citation ID. The evidence text, not a URL or
file path, is the entire local source. A separate optional grader file has the
same version and one `caseId`/`label` result per case.

```json
{
  "schemaVersion": "1",
  "evidence": [{ "id": "e1", "text": "The study enrolled 20 volunteers." }],
  "cases": [{
    "id": "case-1", "claim": "The study enrolled 20 volunteers.",
    "citationIds": ["e1"], "humanLabel": "supported"
  }]
}
```

Human labels are `supported`, `unsupported` or `uncertain`. They are the
**fixture's** ground truth, not independently verified truth. `uncertain`
prevents a clean result. The numerical check extracts number-like tokens from
the claim and cited text. A claim or evidence entry must have visible text
after control, format and surrounding whitespace characters are removed;
this check does not use the report's 160-character message bound. Numerical
checks use that same visible form. When both contain numbers and a claimed number is
absent from cited numbers, `deterministicOutcome` is `unsupported`; otherwise it
is `uncertain`, **never** automatically `supported`. This is a review signal,
not a semantic entailment engine: paraphrases, units, dates, rounded values and
context can defeat it. A numerical discrepancy against a human `supported`
label is reported as an informational disagreement, not an override of that
label. A supplied grader result is marked `local-supplied-result`, compared to
the human label, and never called ground truth.

The report includes the standard `schemaVersion`, `tool`, `status`, `summary`
and `findings`, plus `basis` and sorted per-case `results`. Findings sort by
`(subject, pointer, ruleId)` and results by case ID using UTF-16 code-unit
order. Report locations use only the input basename and JSON Pointer, never an
absolute host path. Raw claims, evidence and grader file contents are not
echoed. If the evidence index or grader index drops an unusable entry, no
positive assertion is made from surviving entries; comparisons are incomplete.

## Rules and exits

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unreadable`, `grader-unreadable`, `input-invalid`, `input-too-large` | error | Required local file unavailable, invalid or above the byte bound. |
| `depth-limit`, `case-limit`, `evidence-limit`, `findings-truncated`, `analysis-timeout` | error | A declared bound prevented complete analysis. |
| `no-cases` | error | No labeled cases were supplied. |
| `evidence-invalid`, `evidence-duplicate`, `evidence-index-incomplete` | error | Evidence membership or numerical comparison is unknown. |
| `case-invalid`, `case-duplicate` | error | Case content or identity is unusable. |
| `citation-missing`, `citation-orphan` | error | Citation is unusable or absent from a **complete** evidence index. |
| `human-uncertain` | info | Supplied human label does not settle the case. |
| `grader-invalid`, `grader-duplicate`, `grader-index-incomplete`, `grader-result-missing` | error | Optional local grader evidence cannot be compared. |
| `unsupported-claim` | error | Human label marks a claim unsupported. |
| `grader-disagreement` | error | Local grader label differs from the human label. |
| `numeric-signal-disagreement` | info | Numeric review signal and human label differ. |

All rules above `unsupported-claim` mark the report `incomplete`, including
`human-uncertain`; the final three describe complete observations. An unknown
rule ID is a programming error. `status: pass` requires at least one evaluated
case, no unsupported human label, and no error or incomplete finding. It does
**not** claim independently proven grounding.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| 0 | Complete and no failing rule | JSON report |
| 1 | Complete but unsupported label or grader disagreement | JSON report |
| 2 | Invalid option or limit | empty |
| 2 | Unreadable, invalid, unknown or bounded evidence | `incomplete` JSON report |

## Limits

| Flag | Default | Inclusive bound |
| --- | ---: | --- |
| `--max-bytes` | 4194304 | UTF-8 bytes **per input file**, checked before and after read |
| `--max-cases` | 2000 | cases and optional grader results |
| `--max-evidence` | 5000 | evidence entries |
| `--max-depth` | 32 | JSON nesting depth in both files |
| `--max-findings` | 1000 | emitted findings, including truncation marker |
| `--timeout-ms` | 30000 | cooperative analysis milliseconds; maximum 3600000 |

Each bound accepts exactly N and reports N+1 as incomplete. The library
accepts an injected clock for deterministic testing; the CLI uses a monotonic
clock. Timeout is cooperative, not preemptive: a synchronous JSON parse,
filesystem call, native string scan or sort can overrun it before the next
checkpoint. No time value is written into the report.

## Non-goals

- No automatic claim segmentation or human labeling.
- No provider API, model invocation, remote fetching, scoring service or
  default model grader. `--grader` only reads a named local JSON file.
- No semantic entailment or proof that a human label is true.
- No repair, edit, upload, or change to an account or repository.

`npm run check` runs syntax checks, the `node:test` suite, the runnable
examples and a local packaging dry run. See [fixture notes](docs/README.md).

MIT. See [LICENSE](LICENSE).
