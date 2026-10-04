# Make agent identity reasons provider-specific

## Goal

Ensure every unsupported agent provider gets an accurate identity explanation instead of inheriting
OpenCode's wording.

## Scope

- `packages/cezar/src/agent-config/account-identity.ts`
- `packages/cezar/src/agent-config/account-identity.test.ts`
- Regression evidence for #1233 (follow-up from #1113)

## Implementation Plan

### Phase 1: Make unsupported-provider reasons exhaustive

- [ ] 1.1 Confirm the provider fallthrough and current issue reproduction.
- [ ] 1.2 Add exhaustive provider-specific reasons and regression tests.
- [ ] 1.3 Run targeted and configured validation, review the PR, and report evidence.

## Risks

Unsupported providers must not read credentials or invoke CLIs; the change is copy and dispatch
logic only. Adding a provider must require an explicit reason or reader at compile time.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append — <commit sha> when a step lands.

### Phase 1: Make unsupported-provider reasons exhaustive

- [ ] 1.1 Confirm the provider fallthrough and current issue reproduction.
- [ ] 1.2 Add exhaustive provider-specific reasons and regression tests.
- [ ] 1.3 Run targeted and configured validation, review the PR, and report evidence.
