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

With no policy file the ecosystem default applies — one review on the diff for
anything above `read_only`. A project that wants agent content edits to land by
themselves writes that down:

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
