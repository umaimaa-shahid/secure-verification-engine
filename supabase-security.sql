-- Protect backend-owned tables from direct public API access.
-- Prisma connects with the database role, so the Email Engine continues to work.
alter table public.email_logs enable row level security;
alter table public.imap_states enable row level security;