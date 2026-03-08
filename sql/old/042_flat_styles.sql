-- Flatten styles: recalculate global sort_order for style_presets_v2
-- Groups order is preserved (anime first, russian last), styles within groups keep order

UPDATE style_presets_v2 sp SET sort_order = sub.global_order
FROM (
  SELECT sp.id, 
    ROW_NUMBER() OVER (ORDER BY sg.sort_order, sp.sort_order) as global_order
  FROM style_presets_v2 sp
  JOIN style_groups sg ON sg.id = sp.group_id
  WHERE sp.is_active = true
) sub
WHERE sp.id = sub.id;
