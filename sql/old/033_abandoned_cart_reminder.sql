-- Add fields for abandoned cart tracking
-- reminder_sent: for user discount message (30 min)
-- alert_sent: for team notification (15 min)

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reminder_sent boolean DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS alert_sent boolean DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS alert_sent_at timestamptz;

-- Index for efficient abandoned cart queries
CREATE INDEX IF NOT EXISTS idx_transactions_abandoned_cart 
ON transactions (state, reminder_sent, created_at) 
WHERE state = 'created' AND reminder_sent = false;

CREATE INDEX IF NOT EXISTS idx_transactions_abandoned_cart_alert 
ON transactions (state, alert_sent, created_at) 
WHERE state = 'created' AND alert_sent = false;

COMMENT ON COLUMN transactions.reminder_sent IS 'Whether abandoned cart reminder was sent to user';
COMMENT ON COLUMN transactions.reminder_sent_at IS 'When abandoned cart reminder was sent';
COMMENT ON COLUMN transactions.alert_sent IS 'Whether abandoned cart alert was sent to team channel';
COMMENT ON COLUMN transactions.alert_sent_at IS 'When abandoned cart alert was sent';
