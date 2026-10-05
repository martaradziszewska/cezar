# Fix runner lists in dispatch and automation guidance

## Goal

Derive the four dispatch/automation help and prompt runner lists from `RUNNER_IDS`, so every currently supported runner is advertised without changing runtime behavior.

## Scope

- Update the runner lists in `dispatch/task-cli.ts`, `dispatch/prompts.ts`, `automations/automation-cli.ts`, and `automations/prompts.ts`.
- Add focused token-aware regression tests covering every `RUNNER_IDS` id in both CLI help and prompts.
- Do not change the contract package, runner registry, defaults, or unrelated prompt wording.

## Implementation Plan

### Phase 1: Fix and test runner guidance

- [ ] 1.1 Derive all four runner lists from `RUNNER_IDS`.
- [ ] 1.2 Add regression coverage with word-boundary assertions, including the short `pi` id.

### Phase 2: Validate and hand off

- [ ] 2.1 Run focused tests and the configured full validation gate.
- [ ] 2.2 Review the diff, update PR evidence, and report the branch and PR to the parent.

## Risks

This is a low-risk text-only change; interpolation must preserve existing wording and avoid substring false positives such as `api` matching `pi`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands. Do not rename step titles.

### Phase 1: Fix and test runner guidance

- [x] 1.1 Derive all four runner lists from `RUNNER_IDS`. — 318825f0
- [x] 1.2 Add regression coverage with word-boundary assertions, including the short `pi` id. — 318825f0

### Phase 2: Validate and hand off

- [ ] 2.1 Run focused tests and the configured full validation gate.
- [ ] 2.2 Review the diff, update PR evidence, and report the branch and PR to the parent.
