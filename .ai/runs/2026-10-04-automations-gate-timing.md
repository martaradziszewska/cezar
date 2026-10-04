# Remove automation startup test races

## Goal

Make the automation startup tests wait on observable boot outcomes instead of a fixed 50 ms
window, and prove that stale enabled polls are re-baselined before scheduler startup.

## Scope

- `packages/cezar/src/server/automations-gate.test.ts`
- Regression evidence for #1107 and related #930

## Implementation Plan

### Phase 1: Reproduce and harden startup assertions

- [ ] 1.1 Reproduce the fixed-window failures with a delayed git subprocess.
- [ ] 1.2 Replace startup sleeps with bounded observable waits and capture re-baseline-before-start ordering.
- [ ] 1.3 Run targeted and configured validation, review the PR, and report evidence.

## Risks

The test boots the real server and touches temporary stores; assertions must remain bounded and must
not alter production startup behavior. No production files are in scope.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Reproduce and harden startup assertions

- [ ] 1.1 Reproduce the fixed-window failures with a delayed git subprocess.
- [ ] 1.2 Replace startup sleeps with bounded observable waits and capture re-baseline-before-start ordering.
- [ ] 1.3 Run targeted and configured validation, review the PR, and report evidence.
