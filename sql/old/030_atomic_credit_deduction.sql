-- Atomic credit deduction to prevent race conditions
-- Returns true if credits were deducted, false if not enough credits

CREATE OR REPLACE FUNCTION deduct_credits(p_user_id uuid, p_amount int)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  rows_affected int;
BEGIN
  UPDATE users 
  SET credits = credits - p_amount
  WHERE id = p_user_id AND credits >= p_amount;
  
  GET DIAGNOSTICS rows_affected = ROW_COUNT;
  
  RETURN rows_affected > 0;
END;
$$;
