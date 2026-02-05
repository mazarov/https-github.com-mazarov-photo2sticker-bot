-- Atomic check and increment for first free generation
-- Returns true if this is the first generation (was 0, now 1)
-- Returns false if user already had generations

CREATE OR REPLACE FUNCTION claim_first_free_generation(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  rows_affected int;
BEGIN
  UPDATE users 
  SET total_generations = 1
  WHERE id = p_user_id AND (total_generations IS NULL OR total_generations = 0);
  
  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  
  RETURN rows_affected > 0;
END;
$$;

-- Also add function to increment total_generations (for non-first generations)
CREATE OR REPLACE FUNCTION increment_generations(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users 
  SET total_generations = COALESCE(total_generations, 0) + 1
  WHERE id = p_user_id;
END;
$$;
