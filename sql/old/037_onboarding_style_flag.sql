-- Add show_in_onboarding flag to style_groups and style_presets_v2
-- Controls which styles are visible during user onboarding (first 2 stickers)

-- 1. Flag for groups (hide entire category)
ALTER TABLE style_groups 
ADD COLUMN IF NOT EXISTS show_in_onboarding boolean DEFAULT true;

COMMENT ON COLUMN style_groups.show_in_onboarding IS 'If false, group is hidden for users with onboarding_step < 2';

-- 2. Flag for substyles (hide specific style within a group)
ALTER TABLE style_presets_v2 
ADD COLUMN IF NOT EXISTS show_in_onboarding boolean DEFAULT true;

COMMENT ON COLUMN style_presets_v2.show_in_onboarding IS 'If false, substyle is hidden for users with onboarding_step < 2';

-- Examples:
-- Hide entire group for onboarding:
-- UPDATE style_groups SET show_in_onboarding = false WHERE id = 'russian';

-- Hide specific substyle for onboarding:
-- UPDATE style_presets_v2 SET show_in_onboarding = false WHERE id = 'anime_dark';
