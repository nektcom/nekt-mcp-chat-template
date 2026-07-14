# Embedding the chat in a host app

How to run this app in **embedded (iframe) mode** inside your own product — a
client portal, an internal tool, a low-code platform (Lovable, Retool, …), or a
mobile webview. For the message-level protocol, see
[`iframe-message-contract.md`](iframe-message-contract.md); this guide covers
everything around it.

## Architecture

```
Your host app (owns auth + persistence)
  └─ <iframe> → this Next.js app (chat UI + agentic loop)
                  └─ /api/chat, /api/connect → MCP server + LLM
```

Division of responsibilities — this is the whole design:

- **The iframe never touches your database.** It runs the chat UI and the
  MCP/LLM calls, and holds state in memory only.
- **The host owns authentication and persistence.** It decides who the user
  is, which MCP token they get, and where conversations are stored. Writing
  chat data as the *logged-in user* of your system means your existing access
  control (e.g. Postgres RLS) applies natively — no trust in the iframe needed.
- **Everything flows over `postMessage`** between host and iframe: credentials
  in, conversation snapshots out.

## What the chat needs at startup

| Input | How it arrives |
|---|---|
| MCP server URL | `mcp-credentials` message |
| MCP token (per-tenant) | `mcp-credentials` message |
| Session ID | minted in-iframe, or supplied via `mcp-restore-session` |
| Message history | `mcp-restore-session` message (omit for a fresh chat) |

The LLM is **not** configured by the host — it is fixed per deployment via the
`LLM_*` env vars (see `.env.example`). Hosts never handle LLM keys.

## Host-side integration steps

1. **Deploy this app** to a host that runs full-stack Next.js (Vercel or
   similar). It cannot be deployed *inside* frontend-only platforms — embed
   its URL instead. For local development against a remote host, a tunnel
   (e.g. ngrok) works; `next.config.ts` already allows ngrok dev origins.
2. **Allow your origin to frame it.** Browsers block framing unless the framed
   document opts in. Add your host's exact origin(s) to the
   `frame-ancestors` CSP list in `next.config.ts`. Preview and production
   origins usually differ — list both.
3. **Allow your origin to message it.** Set
   `NEXT_PUBLIC_ALLOWED_PARENT_ORIGINS` (comma-separated, exact origins, no
   wildcards) so the iframe accepts your `postMessage` calls. The two lists
   (step 2 and 3) must both include every embedding origin.
4. **Implement the handshake.** Wait for the iframe's `mcp-chat-ready`, then
   send `mcp-credentials` with the MCP url + the current user's token. Reply
   to the event — don't post on iframe `load`, or you may race the listener.
5. **Implement persistence (optional but usual).** On `mcp-session-updated`,
   upsert `{ sessionId, title, messages }` into your store, setting the owner
   from your auth session. To reopen a conversation, send
   `mcp-restore-session` with the stored `sessionId` and `messages`.

## Persistence rules that bite if ignored

- **Store `messages` verbatim** — an opaque jsonb blob of the `UIMessage[]`
  exactly as received. Do not reshape it to `{role, text}` or strip `parts`:
  tool calls and reasoning live inside `parts`, and restore breaks without
  them.
- **Never trust the iframe for identity.** Set `user_id` (or your equivalent)
  from the authenticated session, and enforce ownership on write, so a forged
  or guessed `sessionId` cannot overwrite another user's conversation.
- The host mints or stores the conversation id; a conversation is surfaced
  only after a *completed* assistant turn (mid-stream aborts are not
  persisted).
- One jsonb blob per conversation is the intended model — the iframe emits
  full history every turn, so upserts are lossless and idempotent. Normalize
  into a per-message table only if you need per-message querying.

## Example host-side schemas (Supabase/Postgres)

Worked examples with row-level security, written for a typical multi-tenant
host (users belong to a client/org, admins see everything). Adapt table and
helper names to your schema:

- [`chat-persistence.sql`](chat-persistence.sql) — `chat_conversation` table,
  owner-only RLS + admin override, and the upsert/list/restore query shapes.
- [`client-nekt-credentials.sql`](client-nekt-credentials.sql) — one Nekt MCP
  token per client org, readable only by that org's users, so the host can
  look up and inject the right token per user.

## Security posture (recap)

- The iframe accepts messages only from `NEXT_PUBLIC_ALLOWED_PARENT_ORIGINS`
  and posts back only to the verified host origin — never `*` (except the
  secret-free `mcp-chat-ready` ping).
- The MCP token exists in the iframe's memory and in requests to this app's
  own API routes. It is never sent to the LLM, never logged, never persisted
  by this app.
- The LLM API key lives only in this app's server env — hosts and browsers
  never see it.
