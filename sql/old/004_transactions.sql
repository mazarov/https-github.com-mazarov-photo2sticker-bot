create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  amount int not null,
  price int not null default 0,
  state text not null default 'created',
  is_active boolean default true,
  pre_checkout_query_id text,
  telegram_payment_charge_id text,
  provider_payment_charge_id text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists transactions_user_idx on transactions (user_id);
create index if not exists transactions_state_idx on transactions (state);
create index if not exists transactions_active_idx on transactions (is_active) where is_active = true;
