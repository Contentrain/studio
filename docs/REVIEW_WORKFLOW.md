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
- `review` (plan feature `workflow.review`): writes stay on their `cr/*`
  branch until a reviewer acts. Owners/admins still auto-merge their own
  writes unless the review policy says otherwise.

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
