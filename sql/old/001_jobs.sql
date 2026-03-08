create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null,
  status text not null default 'queued',
  attempts int not null default 0,
  error text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists jobs_status_idx on jobs (status);
create index if not exists jobs_session_idx on jobs (session_id);
