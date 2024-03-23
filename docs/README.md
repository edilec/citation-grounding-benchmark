# Fixture notes

The JSON input is a snapshot, not an instruction document. Claims and evidence
are never executed or fetched. A case is evaluated only against cited evidence
text in the same snapshot. No uncited evidence is silently promoted to support.

The optional grader JSON has shape:

```json
{
  "schemaVersion": "1",
  "results": [{ "caseId": "case-1", "label": "supported" }]
}
```

Each result is a **previously obtained, local** grader output. The CLI has no
provider configuration and never generates such a result. Missing, malformed
or duplicated result entries make comparison incomplete. Disagreement is with
the supplied human label; the grader does not become ground truth.

For machine consumers, inspect `status` first. `results[].humanLabel` is the
fixture label, `results[].deterministicOutcome` is only a numerical review
signal, and `results[].graderOutcome` (when present) is local grader input.
`basis.graderIsGroundTruth` is always `false`. Do not treat an `uncertain`
deterministic outcome as supported or an `incomplete` report as a successful
benchmark. `summary.checked` counts usable, unique cases, not raw array length.

For repeatability, use the same exported UTF-8 JSON bytes. Input order does
not affect result or finding order. There is no timestamp or locale-sensitive
comparison in the report.
