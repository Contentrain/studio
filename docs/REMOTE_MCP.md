# Remote MCP — Connect Claude, ChatGPT and Codex to Studio

Studio exposes a single OAuth-authenticated MCP endpoint that AI apps
connect to. Unlike the API-key surface (`/api/mcp/v1/{projectId}`, see the
MCP Cloud settings tab), the remote endpoint is the same URL for everyone —
which project it operates on is decided during sign-in, not by the URL.

```
https://<your-studio-host>/api/mcp/remote
```

> Availability: the remote endpoint requires the **managed provider pair**
> (`NUXT_AUTH_PROVIDER=managed` + `NUXT_DATABASE_PROVIDER=postgres`) — Studio
> itself acts as the OAuth authorization server, which the Supabase pair
> delegates to GoTrue and therefore cannot host. Plan-wise it is gated by
> `api.mcp_cloud_oauth` (Community, Starter, Pro, Enterprise; not Free).

## How connecting works

1. You add the endpoint URL to your AI app (steps below). The app discovers
   Studio's OAuth server automatically (RFC 9728 / RFC 8414 metadata).
2. Your browser opens Studio. You sign in (if needed) and land on the
   consent screen.
3. You pick the **workspace and project** this connection may access and
   approve the requested permissions.
4. The app receives its tokens and starts calling MCP tools. Access tokens
   expire after 1 hour; apps refresh silently for up to 30 days.

One connection = one project. To switch projects, connect again and pick a
different project (the old connection stays until you disconnect it).

### Permissions (scopes)

| Scope | Grants |
| --- | --- |
| `project:metadata` | Project structure reads: `status`, `describe`, `describe_format` |
| `content:read` | Content reads: `content_list`, `validate`, … |
| `content:write` | Content/model writes: `content_save`, `content_delete`, `model_save`, `model_delete` |
| `media:read` | Media reads: `media_list`, `media_get` |
| `media:write` | Media writes: `media_ingest` (from a URL), `media_update`, `media_delete` |
| `offline_access` | A refresh token (stay connected without re-approving) |

The `media:*` scopes are **advertised only on deployments where the media
stack is configured** (Enterprise + object storage). The media tools
additionally require the workspace plan's `media.upload` feature and the
project's CDN delivery being enabled — where any of those is missing, the
tools don't appear at all. Ingest is **URL-only** (MCP has no binary
channel) and the fetch is SSRF-guarded, MIME-whitelisted and size-capped
server-side. Studio's merge/review lifecycle tools are never exposed over
remote MCP — content writes land as `cr/*` branches and follow the
project's workflow (auto-merge or review), exactly like the API-key
surface; media writes go through the media service, not git.

API keys never gain media tools implicitly: an "unrestricted" key (empty
tool list) still cannot call them — media access must be explicitly
enabled per key (the "Allow media tools" toggle, or by listing the tools).

Calls from remote MCP connections and API keys draw on the **same**
`api.mcp_calls_per_month` workspace quota.

## Connecting each client

**Claude (claude.ai / Desktop):** Settings → Connectors → *Add custom
connector* → paste the endpoint URL. Claude shows a **Connect** card;
approve in the browser popup.

**Claude Code:**

```bash
claude mcp add --transport http contentrain https://<your-studio-host>/api/mcp/remote
```

The OAuth window opens on first use; the callback returns to an ephemeral
localhost port automatically.

**ChatGPT (developer mode):** Settings → *Security and login* → enable
Developer mode, then add the endpoint as an MCP server under Settings →
Plugins.

**Codex:**

```toml
# ~/.codex/config.toml
[mcp_servers.contentrain]
url = "https://<your-studio-host>/api/mcp/remote"
```

Then run `codex mcp login contentrain`.

**MCP Inspector (debugging):** point it at the endpoint URL; it walks the
same discovery + consent flow and lets you exercise every tool.

## Managing connections

Workspace Settings → **Connected Apps** lists every active connection with
its client, project, scopes and monthly call count.

- Workspace **owners/admins** see and can disconnect every connection in
  the workspace; **members** see and manage only their own.
- **Disconnect** revokes the connection's refresh-token family and deletes
  its live access tokens immediately — the app's next request fails with a
  clean re-authorization prompt, nothing breaks silently.
- Deleting the project or removing the user cascades the connection away.

## Troubleshooting

- **The app says it can't reach the server**: the endpoint requires HTTPS
  in production and the managed provider pair (see availability note).
- **"Plan required" errors**: the workspace plan doesn't include
  `api.mcp_cloud_oauth` — upgrade in Settings → Billing.
- **Tool calls fail with permission errors**: the connection's scopes don't
  cover the tool. Clients that support step-up authorization re-prompt for
  consent automatically; otherwise disconnect and reconnect with write
  access approved.
- **429 responses**: per-connection rate limit (60 requests/min) or the
  workspace's monthly MCP call quota — usage is visible in Settings →
  Usage and on each Connected Apps row.
