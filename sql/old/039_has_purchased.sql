-- Migration: Add has_purchased flag for paywall feature
-- Users without purchases see paywall before first generation

ALTER TABLE users ADD COLUMN IF NOT EXISTS has_purchased boolean DEFAULT false;
COMMENT ON COLUMN users.has_purchased IS 'True after first purchase. Used for paywall and +2 bonus credits.';

-- Update existing users who have paid transactions
UPDATE users u
SET has_purchased = true
WHERE EXISTS (
  SELECT 1 FROM transactions t 
  WHERE t.user_id = u.id 
  AND t.state = 'done' 
  AND t.price > 0
);
