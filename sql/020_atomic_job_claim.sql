-- Atomic job claiming with FOR UPDATE SKIP LOCKED
-- Prevents race condition where multiple workers claim the same job

CREATE OR REPLACE FUNCTION claim_job(p_worker_id text)
RETURNS SETOF jobs AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id
    FROM jobs
    WHERE status = 'queued'
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
