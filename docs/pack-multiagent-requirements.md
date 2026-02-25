# Requirements: multi-agent sticker pack generation (test bot)

This document describes the **multi-agent pipeline for generating pack specs** that runs **in the test bot**. All text agents use **OpenAI**. Photo context (subject/couple, gender) is provided by the existing **Gemini**-based detector. Image generation for the pack grid remains on Gemini (worker).

**Product goal:** From an abstract request (e.g. "office humor", "23 February Z style") produce a pack of 9 scenes of **one day** that is viral, shareable, and passes a strict quality gate.

---

## 1. Where it runs: test bot, admin-only

- **No Cursor / no-code mode.** The pipeline is implemented in code and runs in the **test bot** only.
- **Admin-only button: "Сгенерировать пак"** (Generate pack). Shown only to users whose `telegram_id` is in `config.adminIds`.
- **On button press:**
  1. Run the full pipeline (Concept → Boss → Captions → Scenes → Assembly → Critic).
  2. Ensure **unique pack `id`** (e.g. check `pack_content_sets_test` for existing id; if collision, append suffix or reject).
  3. If **Critic pass** — insert the row into `pack_content_sets_test` and show the new pack (e.g. scenes/carousel) in the UI so the user sees it.
  4. If **Critic fail** — do not insert; re-run Captions and/or Scenes (and optionally Concept/Boss) with Critic's suggestions; repeat until pass or max iterations (e.g. 2). On final fail — show admin a clear error (e.g. "Pack rejected by Critic: …").

**Photo context:** Before or at the start of the pipeline, the bot uses the **current user photo** (e.g. from session) and the existing **Gemini** subject detector to get `subject_type` (single_male, single_female, couple). That context is passed into Concept. Photo analysis stays on Gemini; all pack *text* agents are OpenAI.

---

## 2. OpenAI models per role (quality-first)

All agents in the pack pipeline are **OpenAI**. Defaults are set for **quality**: all roles use **gpt-5.2** (flagship model for agentic tasks) unless overridden in app_config.

| Role | Default model | Why |
|------|----------------|-----|
| **Concept** | `gpt-5.2` | Strong brief → better plan and captions downstream; persona/setting set the tone for the whole pack. |
| **Boss** | `gpt-5.2` | Plan drives everything; day_structure and moment variety benefit from a stronger model. |
| **Captions** | `gpt-5.2` | More natural, sendable inner-thought captions; fewer generic phrases. |
| **Scenes** | `gpt-5.2` | Most critical for image generator: precise costume, environment, gaze; no ambiguity. |
| **Critic** | **`gpt-5.2`** | **Quality gate.** Must be strict; weaker models tend to pass too easily. |

**Summary:** All five agents default to **gpt-5.2**. To reduce cost you can override in app_config (e.g. some roles → gpt-4o or gpt-5 mini); Scenes and Critic are best kept on a strong model for quality.

Use **Structured Outputs** (OpenAI JSON schema) for each agent so responses are valid JSON and easy to parse. Config: table **app_config** (keys below); defaults in code: all **gpt-5.2** (quality-first).

### 2.1. app_config: какая строка за какого агента

Управление моделями — через таблицу **app_config**. Одна строка = один агент. Ключ = `key`, значение модели = `value`.

| key (в app_config) | Агент | Роль | default value |
|--------------------|--------|------|----------------|
| `pack_openai_model_concept` | Concept | Запрос + фото → бриф (setting, persona, tone, situation_types) | `gpt-5.2` |
| `pack_openai_model_boss` | Boss | Бриф → план пака (id, name_ru/en, moments[9], day_structure) | `gpt-5.2` |
| `pack_openai_model_captions` | Captions | План → 9 подписей RU + 9 EN | `gpt-5.2` |
| `pack_openai_model_scenes` | Scenes | План + подписи → 9 scene_descriptions с `{subject}` | `gpt-5.2` |
| `pack_openai_model_critic` | Critic | Полный спек → pass/fail + reasons + suggestions (строгий gate) | `gpt-5.2` |

В коде ключи вынесены в `src/lib/pack-multiagent.ts`: `PACK_AGENT_APP_CONFIG_KEYS`. Модели берутся только из app_config; дефолтов в коде нет. Если ключ отсутствует или value пустой/`__` — пайплайн падает с явной ошибкой.

---

## 3. Critic: single quality gate ("раздаёт всем люлей")

The **Critic** is the only agent that can reject the pack. It must:

- **Be strict.** Pass only when the spec truly meets virality, one-day arc, caption quality (no nonsense/typos), and scene consistency. If captions are generic or scenes ignore costume/environment — **fail**.
- **Give clear reasons.** Output `reasons` (what’s wrong) and `suggestions` (what to fix). No vague "could be better"; concrete "caption 4 is descriptive, replace with inner thought" or "scene 7 missing gaze at camera".
- **Trigger re-run.** On fail, the orchestrator re-runs Captions and/or Scenes (and optionally earlier agents) with Critic’s suggestions, then calls Critic again. No insert into DB until pass.

Prompt for Critic must state explicitly: "You are the quality gate. Reject any pack that has generic captions, broken one-day continuity, missing costume/environment in scenes when theme requires it, or typos/nonsense in labels. Be strict; pass only when the pack is truly sendable and coherent."

---

## 4. Pipeline order and data flow

1. **Photo context (Gemini)** — from current session photo → subject_type (single_male / single_female / couple). Existing detector in `subject-profile.ts`.
2. **Concept (OpenAI)** — abstract request + photo context → brief (JSON).
3. **Boss (OpenAI)** — brief → plan (id, name_ru/en, carousel, mood, day_structure, moments[9], subject_mode, pack_template_id, etc.).
4. **Captions (OpenAI)** — plan → labels, labels_en (9 strings each).
5. **Scenes (OpenAI)** — plan + labels → scene_descriptions (9 strings with `{subject}`).
6. **Assembly** — build one row in `pack_content_sets` format (section 6).
7. **Uniqueness check** — ensure `id` is unique in `pack_content_sets_test` (e.g. if exists, append `_v2` or derive new slug).
8. **Critic (OpenAI)** — full spec → pass/fail + reasons + suggestions. If **fail** → re-run from step 4 or 3 with suggestions (and optionally step 2); max N iterations (e.g. 2). If still fail → do not insert; notify admin.
9. **Insert** — insert row into `pack_content_sets_test`.
10. **UI** — show the new pack to the user (e.g. scenes/carousel in the pack flow so the pack appears in the list and can be chosen for preview/generation).

Captions → Scenes in sequence (Scenes can use labels). Concept and Boss in sequence. All agents use structured JSON output.

**Iteration (Critic-driven only):** Agents do not "chat" with each other. The only loop is: Critic returns fail → orchestrator re-runs Captions and/or Scenes (and optionally Concept/Boss), injecting Critic's `suggestions` into their prompts → then Critic runs again. So iteration is one-way: Critic's feedback is used to re-run earlier agents; no multi-turn dialogue between agents.

---

## 4.1. How Google does it (alignment with Google patterns)

Our pipeline matches the patterns recommended by **Google Cloud / Agent Development Kit (ADK)** and Google's agentic architecture docs:

| Google pattern | Our implementation |
|----------------|--------------------|
| **Sequential pipeline** | Concept → Boss → Captions → Scenes → Assembly in a fixed order. Output of each step is input to the next (shared state = JSON passed between steps). No LLM decides the flow — orchestration is **deterministic code**. |
| **Review and critique (generator + critic)** | Generator chain (Concept, Boss, Captions, Scenes) produces the pack spec; **Critic** evaluates it. Critic can approve (pass) or reject with reasons and suggestions. |
| **Loop pattern (iterative refinement)** | On Critic fail we re-run Captions/Scenes (and optionally earlier agents) with Critic's `suggestions` in the prompt, then call Critic again. **Termination:** either Critic pass (success) or **max iterations** (e.g. 2) to avoid infinite loops. Same idea as ADK's LoopAgent(Writer, Critic) with max_iterations and escalation/exit condition. |
| **Single responsibility** | Each agent has one role and one output schema. No "mega-agent" that does everything. |
| **Structured control flow** | Workflow is predefined (sequential + one loop driven by Critic). No coordinator LLM routing dynamically — reduces cost and keeps behavior predictable. |

**Production-style practices (from Google's guides):**

- **Externalized prompts** — keep system prompts per agent in config/files, not hardcoded in code.
- **Structured outputs** — every agent returns JSON (OpenAI Structured Outputs / schema); no free-form text parsing.
- **Explicit exit condition** — loop ends on Critic pass or max_iterations; never "until someone says stop" without a cap.
- **One quality gate** — Critic is the single point of rejection; no conflicting "reviewers".

If we later migrate agents to Gemini and want a framework, **ADK** offers `SequentialAgent` for the main pipeline and `LoopAgent(sub_agents=[Captions+Scenes, Critic], max_iterations=N)` for the refinement loop; the *pattern* would stay the same. For the test bot, a simple orchestrator in TypeScript that calls OpenAI per step and implements the same flow is sufficient and matches "how Google does it" at the design level.

---

## 5. Agent roles (summary)

| Agent | Input | Output | Purpose |
|-------|--------|--------|--------|
| **Concept** | Abstract request + photo context (subject_type) | Brief: setting, persona, tone, timeline=one_day, situation_types, shareability_hook, title_hint | Fit concept to character(s) on photo. |
| **Boss** | Brief | Plan: id, name_ru/en, carousel, mood, day_structure, story_arc, tone, moments[9], subject_mode, pack_template_id | One day, 9 events (not emotions). |
| **Captions** | Plan | labels (RU), labels_en (EN) — 9 each | Inner thoughts, not labels; sendable. |
| **Scenes** | Plan + labels | scene_descriptions — 9 strings with `{subject}` | Costume/environment when theme requires; gaze 3×3; one day. |
| **Critic** | Full spec (plan + labels + scenes) | pass, reasons, suggestions | Strict gate; reject bad quality; force re-run. |

---

## 6. Target output format (= pack_content_sets)

Pipeline output = one row compatible with `pack_content_sets` / `pack_content_sets_test`:

| Column | Filled by | Description |
|--------|-----------|-------------|
| id | Boss (unique) | Pack slug, snake_case; must be unique in target table. |
| pack_template_id | Boss | e.g. `couple_v1` |
| name_ru, name_en | Boss | Pack name |
| carousel_description_ru, carousel_description_en | Boss | Short carousel text |
| labels, labels_en | Captions | Array of 9 strings |
| scene_descriptions | Scenes | Array of 9 strings with `{subject}` |
| sort_order | Boss | e.g. next free number |
| is_active | Assembly | true |
| mood | Boss | everyday, reactions, affection, sarcasm, … |
| sticker_count | Assembly | 9 |
| subject_mode | Boss | single | couple |
| cluster | Assembly | false |
| segment_id | Boss | e.g. home, affection_support |

After Critic pass and uniqueness check, insert into `pack_content_sets_test`. Scenes are then shown in the pack UI (user can select this pack and generate preview via existing worker).

---

## 7. Agent details (inputs/outputs)

### 7.1. Concept

- **Input:** User request (text) + photo context (subject_type from Gemini detector).
- **Output (JSON):** subject_type, setting, persona, tone, timeline=one_day, situation_types[], shareability_hook, title_hint.
- **Rules:** No concrete 9 scenes; brief must match character(s) on photo (single vs couple).

### 7.2. Boss

- **Input:** Brief (JSON).
- **Output (JSON):** id, pack_template_id, subject_mode, name_ru, name_en, carousel_description_ru/en, mood, sort_order, segment_id, story_arc, tone, day_structure[9], moments[9] (events, not emotions).
- **Rules:** One day; 9 visually distinct moments; day_structure morning/midday/evening.

### 7.3. Captions

- **Input:** Plan (JSON).
- **Output (JSON):** labels[9], labels_en[9].
- **Rules:** Inner thoughts, not emotion labels; no typos/nonsense; sendable in chat.

### 7.4. Scenes

- **Input:** Plan + labels (JSON).
- **Output (JSON):** scene_descriptions[9] — each string with `{subject}`, chest-up, gaze direction, and when theme requires: **costume** (e.g. "wearing military uniform") and **environment** (e.g. "in barracks", "at mess hall") in every scene.
- **Rules:** 2–3 gaze at camera; at most one scene with closed eyes; costume and environment from theme.

### 7.5. Critic

- **Input:** Full spec (plan + labels + scene_descriptions).
- **Output (JSON):** pass (boolean), reasons (string[]), suggestions (string[]).
- **Rules:** Strict. Reject on: generic captions, broken one-day arc, missing costume/environment when required, typos, weak virality. Be explicit so orchestrator can re-run the right agents.

---

## 8. STICKER PACK MASTER SYSTEM (rules for agents)

Agents must follow the framework (moment not emotion; 70% intensity; no static poses; 3×3 gaze balance; captions = inner thoughts; one day; costume/environment in scenes when theme requires). See distribution:

- **Concept:** situation_types = events; timeline one_day; tone; shareability_hook.
- **Boss:** moments = events; story_arc, day_structure; 9 visually distinct moments.
- **Captions:** Inner thoughts; tone; each caption stands alone.
- **Scenes:** Gaze 2–3 at camera; costume + environment when theme requires; no duplicate poses.
- **Critic:** All sections as checklist; strict pass/fail; suggestions for re-run.

Full rules (I–X) remain the reference for prompts and for Critic’s checklist.

---

## 9. Link to code and DB

- **Photo context:** `src/lib/subject-profile.ts` (Gemini detector); use result as subject_type for Concept.
- **Pack content table:** `pack_content_sets_test` on test env; worker reads `scene_descriptions`, `labels` for pack preview (`src/worker.ts`, `runPackPreviewJob`).
- **Admin check:** `config.adminIds` (from env `ADMIN_IDS`); show "Сгенерировать пак" only to these users.
- **New code:** Orchestrator that calls OpenAI per agent (Concept, Boss, Captions, Scenes, Critic), enforces unique id, inserts into `pack_content_sets_test` on Critic pass, and exposes the new pack in the pack selection UI.

After implementation, update `docs/architecture/` (e.g. 12-models-and-pack-generation.md or 03-ai-assistant.md) with the chosen OpenAI model keys and file locations.

---

## Appendix A. STICKER PACK MASTER SYSTEM (full checklist)

Use for agent prompts and for Critic's evaluation criteria.

- **I. Moment, not emotion** — Design moments (message sent, coffee spilled), not "happy/sad".
- **II. 70% rule** — Expression intensity ~70%; hyperbole in situation, not in face.
- **III. Body & composition** — No static poses; torso rotation, weight shift; grid 3×3: 2–3 gaze at camera, 3 sideways, 2 down, 1–2 in motion; at most one scene with closed eyes.
- **IV. Micro-story** — Progression (e.g. chaos → composure); each scene = "0.5 seconds after" the event.
- **V. Captions** — Inner thoughts, not labels; short, sendable; tone-consistent.
- **VI. Recognizability** — Each sticker works alone; relatable; avoid over-specific context.
- **VII. What kills a pack** — Similar poses; no forward gaze; too many closed eyes; descriptive captions; no progression; visual monotony.
- **VIII. Pack types** — Same structure; tone adapts (everyday, reactions, affection, sarcasm, …).
- **IX. Final checklist** — Physical movement; intensity below theatrical; visual rhythm; captions sendable; cohesive; each sticker stands alone; would a real person use this? Virality: clear persona/setting, share moment, clear hook, one-day arc.
- **X. Master prompt** — Use the template from .cursor/rules or original doc for Critic suggestions when improving packs.
