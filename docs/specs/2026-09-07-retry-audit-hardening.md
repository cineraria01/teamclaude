# Retry-cycle audit hardening

## Goal and scope

Harden the test-only retry-cycle structural auditor so executable writes and
shadow bindings cannot evade the guard through JavaScript lexical or binding
syntax. This follows reset-credit integration PR #26 and changes no production
source, account configuration, or deployment.

Risk: L due to the cumulative change size (more than 400 added lines including
regression cases). Data classification: L1. The user authorized documentation
and merge of the reviewed fixes. Two independent review lanes are required.

## Acceptance

- Detect writes, redeclarations, destructuring targets, grouped assignments,
  keyword-named methods, and dynamic-evaluation hazards affecting retry state.
- Require the retry helper's reset to be the exact bare `retryCount = 0;`
  statement; reject larger expressions that merely start with zero.
- Recognize LF, CR, CRLF, U+2028, and U+2029 line-comment boundaries.
- Recognize a regular expression after a `for await` control-flow header.
- Recognize class-body bindings after a function-expression heritage clause.
- Preserve valid read-only expressions and the unchanged production server.

## Implementation plan and non-goals

Transfer the previously tested auditor and regression cases onto the current
integration base. Review only those changes, execute the five reset-credit
test files, and obtain fresh independent review of the resulting source.
No new runtime dependency, proxy behavior, or production rollout is in scope.

Cleanup pass: preserve the already reviewed parser boundary comments and avoid
additional refactoring; the transferred changes are limited to the confirmed
lexical/binding defects and their regression controls.

## Verification

Independent review of the first integration candidate rejected three further
causes: function-heritage member suffixes hid method bindings, `debugger`
followed by ASI hid regex-adjacent writes, and line-separated prefix updates
were treated as postfix updates. Fixes preserve heritage traversal, recognize
the debugger statement boundary, and enforce the no-line-terminator rule for
postfix updates. A subsequent review also required preserving statement-block
classification after `debugger`; its regex rule is separate from expression
keywords. Bare and labelled `break`/`continue` statements also preserve regex
boundaries after ASI. Nine regression cases increase the mutation set to 115.

The source handoff reported 63 passing reset-credit tests and 106 mutation
cases. Those results are historical and do not substitute for testing this
integration candidate. Current validation and gate status are recorded in the
PR evidence after execution.

Candidate checks: scoped ESLint, `node --check` for both JavaScript files,
and `git diff --check` passed. A direct auditor driver accepted the production
source and rejected arithmetic reset expressions, CR-hidden writes,
for-await regex-hidden writes, and function-heritage shadow bindings. The
five-file TAP regression run is queued behind the required machine-load gate;
its result must be collected before merging. A local candidate commit is used
to bind independent review reports to immutable source bytes.

Formal gate status: `UNVERIFIED` with `unattributed-mutation`, reproduced in
the isolated task after normal `apply_patch` edits. Fresh `dispatch-review`
was rejected before a checker ran. The documented delegated recovery did not
resolve this environment's missing mutation attribution. No receipt was
created or reused, and no gate configuration or state was changed manually.
On 2026-09-07 the user explicitly approved a one-time exception for this merge:
replace the unavailable gate-owned receipt with two independent reviewers and
actual test evidence. The failed gate status remains recorded; the exception
does not alter gate configuration or claim a receipt exists. Review results
and runtime audit evidence must identify the exact full candidate commit SHA.

Documentation synchronization: this specification matches the test-only diff.
Existing project instructions remain unchanged (197 lines); no runtime
command, dependency, or architecture contract changed.

The old worktree's `unattributed-mutation` state is preserved. The documented
supported recovery is delegation to an isolated integration worktree with its
own task; this is not a repair or reuse of the old approval state.

## Rollout and rollback

Merge through a PR into `qjc/resilient-routing` after validation. Since changes
are confined to test code and this specification, rollback is a revert of the
integration commit; no service restart or data migration is required.
