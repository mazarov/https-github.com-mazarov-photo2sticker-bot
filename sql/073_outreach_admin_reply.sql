-- Add admin reply fields to user_outreach
ALTER TABLE user_outreach
  ADD COLUMN IF NOT EXISTS admin_reply_text text,
  ADD COLUMN IF NOT EXISTS admin_replied_at timestamptz;
