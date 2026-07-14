# Embedded chat — `postMessage` contract

When run in embedded mode, the MCP chat lives inside an `<iframe>`. The
**parent** (your host app — a client portal, Lovable, Retool, anything that can
render an iframe) owns authentication and persistence; the **iframe** runs the
chat UI and the MCP/LLM calls. They communicate only via `window.postMessage`.
This is the source of truth for both sides — keep them in sync.

For the end-to-end integration walkthrough (deployment, CSP, persistence
patterns), see `docs/embedding-guide.md`.

## Security rules (enforced in `src/app/page.tsx`)

- The iframe **only accepts** messages whose `event.origin` is in
  `NEXT_PUBLIC_ALLOWED_PARENT_ORIGINS` (comma-separated, exact origins, no
  wildcards). Anything else is ignored with a console warning.
- The iframe captures the first trusted origin as `hostOrigin` and posts updates
  back to **that exact origin** — never `*`. If no trusted origin was seen, it
  skips surfacing rather than broadcasting.
- The parent should verify `event.source === iframe.contentWindow` and the
  expected `event.data.type` before trusting a message.
- The MCP token lives only in the iframe's memory for the session; it is sent to
  the app's own API routes, never to the LLM and never logged.

## Handshake / ordering

1. Iframe mounts → posts **`mcp-chat-ready`** to the parent (target origin `*`;
   no secret in it).
2. Parent waits for `mcp-chat-ready`, then sends **`mcp-credentials`**.
3. Iframe validates + connects to the MCP server; the chat becomes usable.
4. (Optional) Parent sends **`mcp-restore-session`** to open saved history, or
   **`mcp-new-session`** to start fresh. If neither is sent, the iframe starts a
   blank session on connect.
5. After each completed turn, iframe posts **`mcp-session-updated`**; parent
   persists it in its own store (any DB).

> Race note: the iframe sends `mcp-chat-ready` once. The parent should reply to
> that event rather than posting on the iframe's `load`, to avoid sending before
> the iframe's listener is attached.

## Parent → iframe

### `mcp-credentials`
Inject the MCP connection. Required before the chat works.
```ts
{ type: 'mcp-credentials', url: string, token: string }
```
- `url` — MCP server URL (same for everyone, but injected).
- `token` — bearer token the chat uses to talk to the Nekt MCP server.
- Empty/missing `url`/`token` are ignored (warns).

### `mcp-restore-session`
Open a saved conversation. Replaces the current one (the chat remounts with this
history).
```ts
{ type: 'mcp-restore-session', sessionId: string, messages: UIMessage[] }
```
- `messages` **must be the verbatim array** previously received via
  `mcp-session-updated`. Store it as a jsonb blob and return it unchanged —
  do not reshape to `{role, text}` or strip `parts`, or history will hydrate
  broken (tool calls / reasoning are inside `parts`).

### `mcp-new-session`
Start a brand-new, empty conversation. The iframe mints the id and reveals it in
the next `mcp-session-updated`.
```ts
{ type: 'mcp-new-session' }
```

## Iframe → parent

### `mcp-chat-ready`
Sent once on mount. Cue for the parent to send `mcp-credentials`.
```ts
{ type: 'mcp-chat-ready' }
```

### `mcp-session-updated`
Sent after each **completed** assistant turn (not on error/abort). Carries the
full conversation for the parent to persist.
```ts
{ type: 'mcp-session-updated', sessionId: string, title: string, messages: UIMessage[] }
```
- `sessionId` — stable id for this conversation; use as the upsert key.
- `title` — first ~80 chars of the first user message (for the list UI).
- `messages` — entire `UIMessage[]` so far; **store verbatim** (see above).

## Parent persistence (summary)

This app stores nothing — conversation history is entirely the parent's job.
On `mcp-session-updated`, upsert the payload into your own store, always
setting the owning user from the **authenticated session** (never from the
iframe payload — a forged `sessionId` must not hijack another user's row).
A worked Supabase/Postgres example schema with row-level security lives in
`docs/chat-persistence.sql`; the mapping is:

| Field (this contract) | Column |
|---|---|
| `sessionId` | `id` (pk / upsert key) |
| — (auth session) | `user_id` |
| — (user's org) | `client_id` |
| `title` | `title` |
| `messages` | `messages` (jsonb, verbatim) |
