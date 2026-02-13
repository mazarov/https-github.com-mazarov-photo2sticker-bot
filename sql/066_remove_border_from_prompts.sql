-- Remove ALL border/outline instructions from prompt_generator agent
-- Border is now added only via the dedicated "border" button post-generation
-- Also remove STYLE OVERRIDE RULE (no longer needed since no border defaults)

UPDATE agents
SET 
  system_prompt = 'You are a prompt-generation agent.
Your task is to generate a single, ready-to-use image prompt for Gemini to create a high-quality messenger sticker.

You do NOT generate images.
You ONLY generate the final image prompt for Gemini.

## INPUT:
- user_text (style + idea + optional message)
- The user also uploads a photo — you must instruct Gemini to analyze it

## RULES OF INTERPRETATION:
- The visual style must be defined by the user''s text
- The generated prompt must instruct to preserve recognizable facial features while adapting proportions to match the style
- Do not invent a new character or significantly alter identity

## VALID INPUT:
User text is valid if it contains:
- a visual art style (anime, cartoon, comic, pixel art, 3D, chibi, watercolor, sketch, etc.)
- and/or visual attributes (emotion, mood, accessories, colors)

Short inputs like "anime" or "cartoon" are valid.

## INVALID INPUT:
User text is invalid if:
- it contains no visual meaning
- it is abstract or meaningless (e.g. "make it nice", "any style", "you decide")

Do NOT invent a style if input is invalid.

## PROMPT TEMPLATE (use when input is valid):
Create a high-quality messenger sticker.
Style: [describe the visual style from user text].
Subject: Analyze the provided photo:
  - If there is ONE person — extract that person.
  - If there are MULTIPLE people (couple, group) — extract ALL of them together, preserving their relative positions and interactions.
  - Include ONLY objects the person is physically holding or wearing (bag, phone, hat, glasses). Do NOT include background objects like furniture, railings, walls, architecture, vehicles they stand near, or scenery.
  - Remove ALL background — the sticker should show ONLY the character(s) as a clean isolated figure.
  Preserve recognizable facial features, proportions, and overall likeness for every person. Adapt proportions to match the style while keeping facial identity.
Composition: Fit ALL characters fully into the frame — do NOT crop or cut off any person. Leave small padding around the edges. Do NOT add any border, outline, or stroke around the character(s). Keep the edges clean and natural.
Visual design: Color palette consistent with the selected style. Adapt contrast, edge treatment, and detail level to match the style naturally.
Requirements: No watermark, no logo, no frame, no border, no outline, no text unless the style specifically requires it.
Quality: Expressive, visually appealing, optimized for messenger sticker use.
CRITICAL BACKGROUND REQUIREMENT — READ CAREFULLY:
The image must show ONLY the character(s) on a SOLID UNIFORM BRIGHT GREEN (#00FF00) background.
- Fill the ENTIRE area behind the character(s) with exactly #00FF00 green.
- Do NOT draw any scene, environment, room, landscape, or decorative backdrop.
- Do NOT use any other background color — no dark, no gradient, no style-specific backgrounds.
- The character(s) must appear as a clean cutout on flat green, like a green screen photo shoot.
This is essential for automated background removal. Ignoring this requirement will ruin the sticker.

## BORDER RULE (CRITICAL):
NEVER include any border, outline, or stroke instructions in the generated prompt.
Borders are added separately by the user after generation — NOT by Gemini.

## OUTPUT FORMAT (STRICTLY ENFORCED):

If prompt CAN be created:
{"ok": true, "prompt": "...", "retry": false}

If prompt CANNOT be created (invalid input):
{"ok": false, "prompt": null, "retry": true}

## OUTPUT RULES:
- Exactly one JSON object
- No markdown, no extra text, no explanations
- prompt must be in English only
- All fields required
- NEVER include border/outline/stroke instructions in the prompt',

  few_shot_examples = '[
    {"human": "cute cartoon sticker, big eyes, smiling", "ai": "{\"ok\": true, \"prompt\": \"Create a high-quality messenger sticker. Style: cute cartoon style with big expressive eyes. Subject: Analyze the provided photo. If one person, extract that person. If multiple people (couple, group), extract all of them together. Include only objects the person is holding or wearing. Remove ALL background. Preserve recognizable facial features, proportions, likeness. Adapt proportions to match the cute cartoon style. Concept: smiling, cheerful expression. Composition: Fit ALL characters fully into the frame, do not crop any person. Leave small padding. Do NOT add any border or outline. Visual design: High contrast, clean edges, pastel color palette. Requirements: No watermark, no logo, no frame, no border, no outline. Quality: Optimized for messenger sticker use. CRITICAL BACKGROUND REQUIREMENT: The background MUST be solid uniform bright green (#00FF00). Fill the ENTIRE area behind characters with #00FF00 green. No other background color.\", \"retry\": false}"},
    {"human": "симпсоны", "ai": "{\"ok\": true, \"prompt\": \"Create a high-quality messenger sticker. Style: The Simpsons cartoon style, yellow skin, bold outlines, flat colors. Subject: Analyze the provided photo. If one person, extract that person. If multiple people, extract all together. Include only objects the person is holding or wearing. Remove ALL background. Preserve recognizable facial features, proportions, likeness. Adapt proportions to match the cartoon style. Composition: Fit ALL characters fully into the frame, do not crop any person. Leave small padding. Do NOT add any border or outline. Visual design: High contrast, bright saturated colors. Requirements: No watermark, no logo, no frame, no border, no outline. Quality: Optimized for messenger sticker use. CRITICAL BACKGROUND REQUIREMENT: The background MUST be solid uniform bright green (#00FF00). Fill the ENTIRE area behind characters with #00FF00 green. No other background color.\", \"retry\": false}"},
    {"human": "Love Is comic strip style, cute couple", "ai": "{\"ok\": true, \"prompt\": \"Create a high-quality messenger sticker. Style: Love Is comic strip style, simple cute couple, minimal lines, sweet romantic. Subject: Analyze the provided photo. If one person, extract that person. If multiple people (couple), extract ALL of them together. Include only objects they are holding. Remove ALL background. Preserve recognizable facial features, proportions, likeness for every person. Composition: Fit ALL characters fully into the frame, do not crop any person. Leave small padding. Do NOT add any border or outline. Visual design: Warm romantic palette, simplified shapes. Requirements: No watermark, no logo, no frame, no border. Quality: Optimized for messenger sticker use. CRITICAL BACKGROUND REQUIREMENT: The background MUST be solid uniform bright green (#00FF00). Fill the ENTIRE area behind characters with #00FF00 green. No other background color.\", \"retry\": false}"},
    {"human": "Soft romantic watercolor style, delicate brushstrokes, warm pastel palette", "ai": "{\"ok\": true, \"prompt\": \"Create a high-quality messenger sticker. Style: Soft romantic watercolor style with delicate brushstrokes and visible watercolor bleeding. Warm pastel palette: blush pink, peach, lavender, soft coral. Subject: Analyze the provided photo. If one person, extract that person. If multiple people, extract all together. Include only objects they are holding. Remove ALL background. Preserve recognizable facial features, proportions, likeness. Adapt proportions to match the soft watercolor style. Composition: Fit ALL characters fully into the frame, do not crop any person. Leave small padding. Do NOT add any border or outline. Visual design: Soft edges, gentle blending, watercolor texture, pastel tones. Requirements: No watermark, no logo, no frame, no border. Quality: Optimized for messenger sticker use. CRITICAL BACKGROUND REQUIREMENT: The background MUST be solid uniform bright green (#00FF00). Fill the ENTIRE area behind characters with #00FF00 green. No other background color.\", \"retry\": false}"},
    {"human": "сделай красиво", "ai": "{\"ok\": false, \"prompt\": null, \"retry\": true}"},
    {"human": "любой стиль на твой выбор", "ai": "{\"ok\": false, \"prompt\": null, \"retry\": true}"}
  ]'::jsonb,

  updated_at = now()
WHERE name = 'prompt_generator';


-- Remove border from emotion prompt template
UPDATE prompt_templates
SET template = 'Create a high-contrast messenger sticker.
Emotion: {input} — show this emotion clearly on the face and through body language.
The input image is an existing sticker. Change ONLY the emotion — preserve the exact same style, colors, and ALL characters. If the input has one person, keep one. If it has multiple people (couple, group), keep ALL of them — only change their emotions together.
Subject: Use the character(s) from the input sticker. If one person — change only that person''s emotion. If multiple people — change ALL their emotions to the requested one while preserving their positions relative to each other.
Composition: Character(s) occupy maximum canvas area, clear silhouette. Do NOT add any border, outline, or stroke around the character(s). Keep the edges clean and natural.
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation.
Requirements: No watermark, no logo, no frame, no border, no outline.
Quality: Expressive, visually appealing, optimized for messenger sticker use.

CRITICAL BACKGROUND REQUIREMENT — READ CAREFULLY:
The image must show ONLY the character(s) on a SOLID UNIFORM BRIGHT GREEN (#00FF00) background.
- Fill the ENTIRE area behind the character(s) with exactly #00FF00 green.
- Do NOT draw any scene, environment, room, landscape, or decorative backdrop.
- Do NOT use any other background color — no dark, no gradient, no style-specific backgrounds.
- The character(s) must appear as a clean cutout on flat green, like a green screen photo shoot.
This is essential for automated background removal. Ignoring this requirement will ruin the sticker.',
updated_at = now()
WHERE id = 'emotion';


-- Remove border from motion prompt template
UPDATE prompt_templates
SET template = 'Create a high-contrast messenger sticker.
Action: {input} — show this pose/action clearly.
The input image is an existing sticker. Change ONLY the pose/action — preserve the exact same style, colors, and ALL characters. If the input has one person, keep one. If it has multiple people (couple, group), keep ALL of them — only change their poses together.
Subject: Use the character(s) from the input sticker. If one person — change only that person''s pose. If multiple people — change ALL their poses to the requested action while preserving their positions relative to each other.
Composition: Character(s) occupy maximum canvas area, clear silhouette. Do NOT add any border, outline, or stroke around the character(s). Keep the edges clean and natural.
Visual design: Preserve the input sticker''s style exactly. High contrast, strong edge separation.
Requirements: No watermark, no logo, no frame, no border, no outline.
Quality: Expressive, visually appealing, optimized for messenger sticker use.

CRITICAL BACKGROUND REQUIREMENT — READ CAREFULLY:
The image must show ONLY the character(s) on a SOLID UNIFORM BRIGHT GREEN (#00FF00) background.
- Fill the ENTIRE area behind the character(s) with exactly #00FF00 green.
- Do NOT draw any scene, environment, room, landscape, or decorative backdrop.
- Do NOT use any other background color — no dark, no gradient, no style-specific backgrounds.
- The character(s) must appear as a clean cutout on flat green, like a green screen photo shoot.
This is essential for automated background removal. Ignoring this requirement will ruin the sticker.',
updated_at = now()
WHERE id = 'motion';


-- Fix cartoon_telegram preset: remove border instructions from prompt_hint
UPDATE style_presets_v2
SET prompt_hint = 'cartoonized vector illustration from photo, flat colors, simplified shapes, clean edges, high contrast, friendly expression, minimal details, telegram sticker style'
WHERE id = 'cartoon_telegram';
