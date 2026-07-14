-- EXAMPLE host-side schema: chat persistence for the embedded MCP chat.
--
-- Context: the chat runs in an <iframe>. The PARENT (your host app) owns auth
-- and persistence — it writes to this table as its logged-in user, so RLS
-- enforces visibility natively via auth.uid(). The iframe never touches the DB;
-- it surfaces the full conversation over postMessage (mcp-session-updated) and
-- the parent upserts it here. See docs/iframe-message-contract.md and
-- docs/embedding-guide.md.
--
-- Written for a typical multi-tenant Supabase host where users live in
-- users_metadata, orgs in "Client", and SECURITY DEFINER helpers exist
-- (is_admin / set_updated_at). ADAPT the table names, FK targets, and helper
-- functions to your own schema — the shape that matters is: sessionId as pk,
-- owner from the auth session, messages as a verbatim jsonb blob.

create table if not exists public.chat_conversation (
  id          uuid primary key,                                   -- the sessionId minted by the iframe
  user_id     uuid not null references public.users_metadata (id) on delete cascade,
  client_id   uuid references public."Client" (id) on delete set null,  -- the org (optional)
  title       text not null default 'New chat',
  messages    jsonb not null default '[]'::jsonb,                  -- full UIMessage[] from the iframe, stored verbatim
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Conversation list: "my newest first". RLS already scopes rows to the user.
create index if not exists chat_conversation_user_idx
  on public.chat_conversation (user_id, updated_at desc);

-- Reuse the existing updated_at trigger helper.
drop trigger if exists chat_conversation_touch on public.chat_conversation;
create trigger chat_conversation_touch
  before update on public.chat_conversation
  for each row execute function public.set_updated_at();

alter table public.chat_conversation enable row level security;

-- Each user sees/creates/edits/deletes ONLY their own conversations.
-- with_check ties ownership to the caller, so a forged/guessed sessionId from
-- the iframe cannot hijack another user's row.
drop policy if exists chat_conversation_owner_all on public.chat_conversation;
create policy chat_conversation_owner_all on public.chat_conversation
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Global admins (users_metadata.role = 'admin') see/manage everything, across
-- all organizations. Swap is_admin -> is_staff if members should too.
drop policy if exists chat_conversation_admin_all on public.chat_conversation;
create policy chat_conversation_admin_all on public.chat_conversation
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Parent-side upsert shape (run as the authenticated user, e.g. supabase-js):
--
--   await supabase.from('chat_conversation').upsert({
--     id:        sessionId,                 // from mcp-session-updated
--     user_id:   session.user.id,           // ALWAYS from the auth session, never the iframe
--     client_id: currentUserClientId,       // the user's org, or null
--     title,                                // from mcp-session-updated
--     messages,                             // from mcp-session-updated, stored verbatim
--   });
--
-- List:    select id, title, updated_at from chat_conversation order by updated_at desc;
-- Restore: select messages from chat_conversation where id = $sessionId;
--          -> postMessage { type: 'mcp-restore-session', sessionId, messages }
-- ---------------------------------------------------------------------------
