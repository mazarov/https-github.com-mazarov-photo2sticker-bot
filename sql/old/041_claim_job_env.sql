-- Update claim_job to support env filter
-- Worker only claims jobs from its own environment

-- Drop old single-param version to avoid ambiguity
DROP FUNCTION IF EXISTS claim_job(text);

CREATE OR REPLACE FUNCTION claim_job(p_worker_id text, p_env text DEFAULT 'prod')
RETURNS SETOF jobs AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id
    FROM jobs
    WHERE status = 'queued'
      AND (env = p_env OR env IS NULL)
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs
  SET 
    status = 'processing',
    worker_id = p_worker_id,
    started_at = now()
  FROM claimed
  WHERE jobs.id = claimed.id
  RETURNING jobs.*;
END;
$$ LANGUAGE plpgsql;
