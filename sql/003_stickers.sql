-- Stickers history table
create table if not exists stickers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  session_id uuid not null,
  
  -- Input
  source_photo_file_id text not null,   -- Telegram file_id (Telegram stores the file)
  user_input text,                       -- Original user text (style description)
  generated_prompt text,                 -- LLM-generated prompt
  
  -- Output
  result_storage_path text,              -- Path in Supabase Storage
  sticker_set_name text,
  
  created_at timestamp with time zone default now()
);

create index if not exists stickers_user_idx on stickers (user_id, created_at desc);
create index if not exists stickers_session_idx on stickers (session_id);
