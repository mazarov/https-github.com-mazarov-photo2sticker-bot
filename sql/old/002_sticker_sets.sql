create table if not exists sticker_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid not null,
  name text not null,
  title text,
  created_at timestamp with time zone default now()
);

create index if not exists sticker_sets_user_idx on sticker_sets (user_id);
create index if not exists sticker_sets_session_idx on sticker_sets (session_id);
