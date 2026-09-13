# Review Workflow

How a content change moves from a `cr/*` branch to the `contentrain` branch
(the single source of truth every reader uses), and what a reviewer can do
with it.

```
write ──► cr/<scope>/<target>/<locale>/<ts>  ──► review ──► merge ──► contentrain ──► main
                                                  │
                                                  ├── reject   (branch deleted)
                                                  └── request changes (branch stays; author fixes; merge later)
```

## Branch sync

`contentrain` is the content SSOT; the repository's own branch (`main` /
`master`) is where the site builds from. A merge lands content on `contentrain`
and then advances the base branch — two separate facts, and the second one can
fail without the first being in doubt.

Studio reports where the two stand as a standing reading
(`GET …/branches/health` and `GET …/branches`, `sync`):

| state | what it means | what resolves it |
|---|---|---|
| `in_sync` | same commit | nothing |
| `content_ahead` | content has landed that the base branch does not carry | the advance, which runs at the end of a turn |
| `base_ahead` | someone pushed to the base branch; content has nothing of its own | **fast-forward** — mechanical, nothing to decide |
| `diverged` | both sides carry commits the other does not | the reconcile, or the pull request Studio opens |
| `unknown` | Studio could not tell — no `contentrain` branch yet, no common history, or a provider without `getMergeBase` | — |

`unknown` is reported rather than guessed: answering `in_sync` for any of those
would be a lie in the reassuring direction.

The reading is derived from branch tips and a merge base — primitives every
provider has — rather than a host's compare endpoint, and cached for two
minutes. The TTL is the floor, not the mechanism: a merge drops it, and so does
a GitHub push webhook, because a push from outside Studio is exactly when it
becomes wrong.

The sidebar shows a line whenever the state is anything but `in_sync`. It stays
silent on `in_sync` on purpose — a row that always says "in sync" is a row
nobody reads on the day it says something else.

## Auto-merge vs review

The project's `workflow` (`.contentrain/config.json`) decides:

- `auto-merge` (default): a write lands on `contentrain` immediately. The
  agent, the content editor, forms, comments and MCP Cloud all follow this.
- `review` (plan feature `workflow.review`): an agent write stays on its `cr/*`
  branch unless the project's approval policy permits that class of change.
  **What is being changed decides — not who asked.** An owner's write is held
  by the same policy as an editor's; the role gate lives on the reviewer
  actions below, where it belongs.

The tool result says which happened: `merged: true`, or a `reviewBranch` plus
an `approval` object carrying the risk class and one line per reason.

## Approval policy

The policy is `.contentrain/approval-policies.json`, read from the
`contentrain` branch. It lives in the repository on purpose: a policy that
lived only in the database could be changed after a change was made and before
it was approved.

With no policy file, one review on the diff is required for anything above
`read_only`, and the author may be the one who gives it. That last part is a
deliberate relaxation of the ecosystem default: on a one-person project a strict
four-eyes rule produces a Merge button that can never be pressed. The approval
is still required and still recorded — to require a *second* person, say so:

```json
{ "version": 1, "allow_self_approval": false, "rules": [{ "risk": "low_risk_content", "gate": "change", "mode": "single" }] }
```

An agent can never approve, with or without that setting.

A project that wants agent content edits to land by themselves writes that down
instead:

```json
{
  "version": 1,
  "default_mode": "single",
  "rules": [
    { "risk": "low_risk_content", "gate": "change", "mode": "auto" }
  ]
}
```

Risk classes are a ladder: `read_only` · `low_risk_content` · `bulk_content` ·
`destructive_schema` · `external_effect` · `financially_material` ·
`deployment`. A rule written at a rung also covers the rungs above it —
**except `mode: "auto"`, which covers only its own rung**, so trusting small
content edits cannot silently exempt a schema change.

That exception has a consequence worth knowing before you write a file: with
only the `auto` rule above and **no `default_mode`**, a schema change matches no
rule at all, and the evaluator takes a policy's silence literally — it merges.
Write `default_mode` unless you mean that.

Studio classifies each agent write by the tool it used: content edits are
`low_risk_content` (lifted to `bulk_content` when one call touches more than one
entry), deletes and locale fan-out are `bulk_content`, and model writes are
`destructive_schema`. The evaluator itself is `@contentrain/types`
(`evaluateApproval`), shared with the CLI, so the same policy answers the same
way everywhere.

A policy file Studio cannot read is not silently ignored: the stricter default
applies and project health reports `invalid_approval_policy` with what is wrong
with the file.

## Approving, and what it is an approval of

A decision is given for one **plan**, not for a branch name. A pending branch's
plan is derived from the branch — the same review the panel renders — so its
hash covers what the change touches and how risky it is. Push another commit
and the hash moves with it, and every decision collected for the old shape stops
counting. Nothing has to remember to invalidate anything.

| action | route | effect |
|---|---|---|
| **Approve** | `POST …/branches/{branch}/approve` `{ note? }` | records your decision for the branch's current plan hash and tip; returns the decision as it now stands |
| **Withdraw** | `DELETE …/branches/{branch}/approve` | removes your own decision — only your own |
| **Approve a release** | `POST …/deploy/approve` | records a decision on the next deploy, at `deployment` risk |
| **Receipts** | `GET …/receipts` | what has run under an approval, newest first |

A decision that does not count comes back with a machine-readable reason
(`plan_hash_mismatch`, `commit_mismatch`, `self_approval`, `role_not_permitted`,
`expired`, …), because the question people actually ask is not "is it blocked"
but "I approved this, why is it still blocked". The panel shows that line.

**A release is not content.** Approving a branch answers "are these words
right"; approving a release answers "is now the moment to publish". They carry
separate plans and separate grants, and neither satisfies the other. A manual
deploy on a review project is refused with the same decision shape until its own
gate is met.

**Receipts.** When a merge or a release goes through, what ran is recorded with
the decisions that permitted it — the grants are cleared with the branch, so the
receipt keeps its own copy. Project overview → *Approvals & releases* on a review
project; each row exports as the `ExecutionReceipt` it is.

## Reviewer actions

Roles: workspace owner/admin, or a project **reviewer**. The review panel
only offers what the caller's role allows (`canMerge`, `canReject`,
`canRequestChanges`).

| action | route | effect |
|---|---|---|
| **Approve** | `POST …/branches/{branch}/merge` | merges into `contentrain`, regenerates `context.json`, advances `main`, fires the deploy hook (`content_published`), `branch.merged` webhook |
| **Reject** | `POST …/branches/{branch}/reject` | deletes the branch, `branch.rejected` webhook |
| **Request changes** | `POST …/branches/{branch}/request-changes` `{ comment }` | keeps the branch open and records the comment; the author sees it in the review panel and the sidebar, the agent sees it in the project state; `branch.changes_requested` webhook |
| **Mark addressed** | `DELETE …/branches/{branch}/request-changes` | any project member; the request is kept as history and reopened by a new request |

An approve or reject clears the request. The branch list
(`GET …/branches`) carries `changesRequested` per branch; the review payload
(`GET …/branches/{branch}/diff`) carries `changesRequested: { comment,
requestedBy, requestedAt } | null`.

Storage: `branch_reviews` (one row per project + branch; `changes_requested`
→ `resolved`; migration `023_branch_reviews.sql`), workspace-scoped RLS.

## In the chat

The agent can `merge_branch`, `reject_branch` and `request_changes` (same
role gate). Pending branches with an open request appear in its project
state as `— changes requested: "…"`, so "what is still blocked and why" is
answerable without opening the panel.

## Webhook events

`branch.merged` · `branch.rejected` · `branch.changes_requested` (with the
comment) — outbound webhooks are an `ee/` feature (`api.webhooks_outbound`).
