-- EXAMPLE host-side schema: per-organization Nekt MCP credentials.
--
-- One token per client org. The parent (your host app) looks up the row for
-- the logged-in user's client_id and injects mcp_token into the embedded chat
-- via the mcp-credentials postMessage (see docs/embedding-guide.md).
--
-- Written for a typical multi-tenant Supabase host with a "Client" org table
-- and SECURITY DEFINER helpers (is_admin / is_staff / get_user_client_id /
-- set_updated_at). ADAPT names and helpers to your own schema — the shape that
-- matters is: one scoped MCP token per tenant, readable only by that tenant's
-- users.

create table if not exists public.client_nekt_credentials (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null unique references public."Client" (id) on delete cascade,
  mcp_token   text not null,
  mcp_url     text,                       -- optional per-client override; null = use the app default
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists client_nekt_credentials_touch on public.client_nekt_credentials;
create trigger client_nekt_credentials_touch
  before update on public.client_nekt_credentials
  for each row execute function public.set_updated_at();

alter table public.client_nekt_credentials enable row level security;

-- Admins manage every org's credentials (mirrors client_credentials posture).
drop policy if exists client_nekt_credentials_admin_all on public.client_nekt_credentials;
create policy client_nekt_credentials_admin_all on public.client_nekt_credentials
  for all to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- A user may READ only their own organization's active token — needed to inject
-- it into the chat running in their browser. They cannot see other orgs' tokens,
-- and cannot write. (The token reaches their browser anyway via injection, so
-- this grants no exposure beyond that.)
drop policy if exists client_nekt_credentials_own_select on public.client_nekt_credentials;
create policy client_nekt_credentials_own_select on public.client_nekt_credentials
  for select to authenticated
  using (is_active and client_id = public.get_user_client_id(auth.uid()));

-- OPTIONAL — only if STAFF (admin+member) also use the chat and should read any
-- org's token (e.g. to chat on behalf of a client). Uncomment if needed:
-- drop policy if exists client_nekt_credentials_staff_select on public.client_nekt_credentials;
-- create policy client_nekt_credentials_staff_select on public.client_nekt_credentials
--   for select to authenticated
--   using (public.is_staff(auth.uid()));
