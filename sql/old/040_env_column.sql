-- Migration: Add env column for test/prod isolation
-- All data in shared Supabase, isolated by env flag

-- users
ALTER TABLE users ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_users_env ON users(env);

-- sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_sessions_env ON sessions(env);

-- jobs
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_jobs_env ON jobs(env);

-- transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_transactions_env ON transactions(env);

-- stickers
ALTER TABLE stickers ADD COLUMN IF NOT EXISTS env text DEFAULT 'prod';
CREATE INDEX IF NOT EXISTS idx_stickers_env ON stickers(env);

-- Cleanup helper:
-- DELETE all test data:
-- WITH d1 AS (DELETE FROM stickers WHERE env = 'test'),
--      d2 AS (DELETE FROM jobs WHERE env = 'test'),
--      d3 AS (DELETE FROM sessions WHERE env = 'test'),
--      d4 AS (DELETE FROM transactions WHERE env = 'test')
-- DELETE FROM users WHERE env = 'test';
