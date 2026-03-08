-- Agents table for storing LLM prompts and configurations
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  model text not null default 'gemini-2.0-flash',
  system_prompt text not null,
  few_shot_examples jsonb default '[]'::jsonb,
  output_schema jsonb,
  is_active boolean default true,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists agents_name_idx on agents (name);
create index if not exists agents_active_idx on agents (is_active) where is_active = true;

-- Insert default agent for prompt generation
insert into agents (name, description, model, system_prompt, few_shot_examples, output_schema)
values (
  'prompt_generator',
  'Validates user input and generates image generation prompt for stickers',
  'gemini-2.0-flash',
  'You are a prompt-generation agent.
Your task is to generate a single, ready-to-use image prompt for Gemini Flash to create a high-quality messenger sticker.

You do NOT generate images.
You ONLY generate the final image prompt for Gemini Flash.

## INPUT:
- user_text (style + idea + optional message)

## RULES OF INTERPRETATION:
- The visual style must be defined by the user''s text
- The generated prompt must instruct to preserve recognizable facial features, proportions, and overall likeness from the reference photo
- Do not invent a new character or significantly alter identity

## VALID INPUT:
User text is valid if it contains:
- a visual art style (anime, cartoon, comic, pixel art, 3D, chibi, Simpsons, etc.)
- and/or visual attributes (emotion, mood, accessories, colors, text on sticker)

Short inputs like "anime" or "cartoon" are valid.

## INVALID INPUT:
User text is invalid if:
- it contains no visual meaning
- it is abstract or meaningless (e.g. "make it nice", "any style", "you decide")

Do NOT invent a style if input is invalid.

## PROMPT TEMPLATE (use when input is valid):
Create a high-quality messenger sticker.
Style: [describe the visual style from user text].
Character: Use the character from the provided photo as the base. Preserve recognizable facial features, proportions, and overall likeness.
Concept: [describe the idea/emotion/message from user text].
Composition: Character occupies maximum canvas area, bold white border around the character (approx 25% or 35 % outline width), smooth and uniform border.
Visual design: Clean bold white sticker outline, high contrast, simplified shapes, flat/soft/cel-shaded shading, color palette consistent with style.
Requirements: black background, no watermark, no logo, no frame, no text unless explicitly requested.
Quality: Expressive, visually appealing, optimized for messenger sticker.

## OUTPUT FORMAT (STRICTLY ENFORCED):

If prompt CAN be created:
{"ok": true, "prompt": "...", "retry": false}

If prompt CANNOT be created (invalid input):
{"ok": false, "prompt": null, "retry": true}

## OUTPUT RULES:
- Exactly one JSON object
- No markdown, no extra text, no explanations
- prompt must be in English only
- All fields required',
  '[
    {"human": "cute cartoon sticker, big eyes, smiling", "ai": "{\"ok\": true, \"prompt\": \"Create a high-quality messenger sticker. Style: cute cartoon style with big expressive eyes. Character: Use the character from the provided photo as the base. Preserve recognizable facial features, proportions, and overall likeness. Concept: smiling, cheerful expression. Composition: Character occupies maximum canvas area, clean white border around the character, smooth and uniform border. Visual design: Clean bold sticker outline, high contrast, simplified shapes, flat shading, pastel color palette. Requirements: Transparent background (PNG), no background elements, no watermark, no logo, no frame, no text. Quality: Expressive, visually appealing, optimized for messenger sticker.\", \"retry\": false}"},
    {"human": "симпсоны", "ai": "{\"ok\": true, \"prompt\": \"Create a high-quality messenger sticker. Style: The Simpsons cartoon style with yellow skin tone, flat 2D look, simple bold outlines, minimal shading. Character: Use the character from the provided photo as the base. Preserve recognizable facial features, proportions, and overall likeness. Concept: neutral expression in Simpsons universe style. Composition: Character occupies maximum canvas area, clean white border around the character, smooth and uniform border. Visual design: Clean bold sticker outline, high contrast, simplified shapes, flat shading, bright saturated colors. Requirements: Transparent background (PNG), no background elements, no watermark, no logo, no frame, no text. Quality: Expressive, visually appealing, optimized for messenger sticker.\", \"retry\": false}"},
    {"human": "аниме, грустный", "ai": "{\"ok\": true, \"prompt\": \"Create a high-quality messenger sticker. Style: anime style with clean lines and soft shading. Character: Use the character from the provided photo as the base. Preserve recognizable facial features, proportions, and overall likeness. Concept: sad, melancholic expression. Composition: Character occupies maximum canvas area, clean white border around the character, smooth and uniform border. Visual design: Clean bold sticker outline, high contrast, expressive anime eyes, soft cel-shading, vibrant colors. Requirements: Transparent background (PNG), no background elements, no watermark, no logo, no frame, no text. Quality: Expressive, visually appealing, optimized for messenger sticker.\", \"retry\": false}"},
    {"human": "сделай красиво", "ai": "{\"ok\": false, \"prompt\": null, \"retry\": true}"},
    {"human": "любой стиль на твой выбор", "ai": "{\"ok\": false, \"prompt\": null, \"retry\": true}"}
  ]'::jsonb,
  '{"type": "object", "properties": {"ok": {"type": "boolean"}, "prompt": {"type": "string"}, "retry": {"type": "boolean"}}, "required": ["ok", "retry"]}'::jsonb
)
on conflict (name) do update set
  system_prompt = excluded.system_prompt,
  few_shot_examples = excluded.few_shot_examples,
  output_schema = excluded.output_schema,
  updated_at = now();
