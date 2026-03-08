-- First free generation feature
-- Add total_generations counter to users
-- Add is_first_free flag to jobs

-- Users: track total generations count
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_generations integer DEFAULT 0;

-- Jobs: flag for first free generation (uses better model)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_first_free boolean DEFAULT false;
