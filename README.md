# Nekt MCP Chat — reference implementation

A stateless Next.js chat app that lets end-users ask natural-language questions about their [Nekt](https://nekt.com)-managed data. The browser supplies an MCP server URL + scoped token per request; the server runs an agentic loop (Vercel AI SDK `streamText`) against the tools discovered from that MCP server, using **one LLM configured per deployment via env vars**.

This repo is a **reference implementation** meant to be read by humans and AI agents alike. Fork it, restyle it, or lift just the backend — the patterns are the product.

## Deployment modes

Both are first-class; pick what fits your product:

1. **Standalone app** — deploy as-is. Users connect through the built-in form (MCP URL + token), or you prefill those with `NEXT_PUBLIC_MCP_SERVER_URL` / `NEXT_PUBLIC_MCP_TOKEN` for a single-tenant install.
2. **Embedded iframe** — mount it inside a host app (client portal, Lovable, Retool, …). The host supplies credentials and session data over a `postMessage` contract. Start with [`docs/embedding-guide.md`](docs/embedding-guide.md); the message-level protocol is in [`docs/iframe-message-contract.md`](docs/iframe-message-contract.md).

## Conversation history is NOT managed here

This backend is deliberately stateless: **no database, no session store, nothing persisted server-side.** Each `/api/chat` request carries the full message array and returns a stream; when the tab closes, in-memory history is gone.

If you want persistent history, implement it in **your** system and inject it back into this app:

- **Iframe mode**: the app posts the full conversation to the parent via `mcp-session-updated` after every exchange; the host stores it (any DB) and rehydrates later with `mcp-restore-session`. A host-side Supabase schema example is in [`docs/chat-persistence.sql`](docs/chat-persistence.sql).
- **Standalone / bring-your-own-UI**: build your own persistence around the `/api/chat` endpoint (it's a standard Vercel AI SDK UIMessage stream — store the messages your client already holds).

## Architecture in brief

| File | Role |
|---|---|
| [`src/app/api/chat/route.ts`](src/app/api/chat/route.ts) | The agentic loop: `streamText` + MCP tools, step cap with a forced final text answer, streamed UIMessage response |
| [`src/lib/models.ts`](src/lib/models.ts) | LLM provider selection + validation from env, per-provider reasoning options |
| [`src/lib/mcp.ts`](src/lib/mcp.ts) | Short-lived MCP client per request; token stays server-side, never reaches the LLM or the browser bundle |
| [`src/app/api/connect/route.ts`](src/app/api/connect/route.ts) | Connection validation — opens the MCP client, lists tools, closes |
| [`src/app/page.tsx`](src/app/page.tsx) | Example UI: connect form, `useChat` streaming, reasoning/tool-call disclosure, table rendering, iframe postMessage handling |

More depth: [`docs/overview.md`](docs/overview.md) (architecture + extension points) and [`docs/iframe-message-contract.md`](docs/iframe-message-contract.md) (embedding protocol).

## Setup

```bash
npm install
cp .env.example .env   # fill in LLM_PROVIDER, LLM_MODEL, LLM_API_KEY
npm run dev
```

Open http://localhost:3000 and connect with your Nekt MCP server URL + token (from the Nekt app), or prefill them via the `NEXT_PUBLIC_*` vars.

## LLM configuration

One deployment = one model. Three env vars, **no defaults and no fallbacks** — a missing value makes `/api/chat` return a 500 with an actionable message rather than silently picking a model.

| `LLM_PROVIDER` | `LLM_MODEL` examples | `LLM_API_KEY` | Notes |
|---|---|---|---|
| `openai` | `gpt-5.1`, `gpt-5-mini`, `gpt-4.1` | platform.openai.com key | |
| `anthropic` | `claude-opus-4-8`, `claude-sonnet-5` | console.anthropic.com key | |
| `google` | `gemini-3.5-flash` | Google AI Studio key | Free tier exists; Pro models are paid-only (429 `limit:0` on free tier) |
| `vertex` | `gemini-3.5-flash` | Vertex AI **express-mode** key (not an AI Studio key) | Or leave the key empty and use ADC with `GOOGLE_VERTEX_PROJECT` + `GOOGLE_VERTEX_LOCATION`. Paid — no free tier |

Optional: `LLM_REASONING=true` surfaces reasoning/"thinking" output for OpenAI reasoning models (gpt-5 family, o-series) and Anthropic adaptive-thinking models (claude-sonnet-4-6+). Leave it unset for non-reasoning models — those APIs reject the options. Gemini reasoning is always requested and needs no flag.

Every variable is documented in [`.env.example`](.env.example).

## Behavior notes (for agents reading this repo)

- **No config defaults**: `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_API_KEY` (or Vertex ADC vars) are required. Misconfiguration → `/api/chat` responds `{ "error": "..." }` with status 500, before any MCP connection is attempted.
- **One deployment = one model**: there is no per-request or per-user model selection; to change models, change env and redeploy.
- **Keys never come from the browser**: the LLM key lives only in server env. The only per-request client-supplied secrets are the MCP url + token, which stay server-side.
- **No server-side persistence of any kind** — see [Conversation history](#conversation-history-is-not-managed-here) above.
- **Tools are discovered, not declared**: whatever the connected MCP server exposes is what the model gets. New server capabilities light up with zero code changes.
- Next.js 16 has breaking changes vs. older training data — read `node_modules/next/dist/docs/` before editing Next-specific code (see `AGENTS.md`).

## Docs

- [`docs/overview.md`](docs/overview.md) — architecture, extension points, adoption tiers
- [`docs/embedding-guide.md`](docs/embedding-guide.md) — end-to-end guide to embedding the chat in a host app
- [`docs/iframe-message-contract.md`](docs/iframe-message-contract.md) — postMessage protocol for embedded mode
- [`docs/chat-persistence.sql`](docs/chat-persistence.sql) — example host-side history schema (Supabase/Postgres + RLS)
- [`docs/client-nekt-credentials.sql`](docs/client-nekt-credentials.sql) — example host-side per-tenant MCP credential storage
