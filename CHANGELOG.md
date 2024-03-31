# Changelog

## Unreleased

- Validated unbounded visible claim and evidence text before comparison, so
  invisible-only input is incomplete and a long but visible claim stays valid.
- Included Unicode default-ignorable marks outside the format category in
  visible-text validation.
- Refused duplicate JSON object keys in both human-labeled fixtures and
  optional local grader results.

## 0.1.0

- Added a local human-labeled claim/evidence benchmark with separate numerical
  and optional locally supplied grader signals.
- Added deterministic JSON reports, conservative unknown handling, bounded
  analysis, a read-only CLI, examples and tests.
