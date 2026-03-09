# 09-03 Child Identity Policy For Style Generation

## Goal

When source contains a child, `generationType=style` must avoid identity replication.

- Default style prompt rule:
  - `Keep identity (facial features/person).`
- Child-safe style prompt rule:
  - `Use the image only as a reference for pose and general appearance.`
  - `Do not replicate the exact identity of the person.`

## Scope

Apply only to:

- `generationType = style`

Do not change behavior for:

- `emotion`
- `motion`
- `text`
- `replace_subject`

## Source Of Truth

Use existing centralized source resolver:

- `resolveGenerationSource(session, generationType)`

Age decision must be tied to actual source pair:

- `source_file_id`
- `source_kind` (`photo` | `sticker`)

## Data Model Requirements

Store age detection in session for current source:

- `subject_age_group`: `child | adult | unknown`
- `subject_age_confidence`: `number | null`
- `subject_age_source_file_id`: `text | null`
- `subject_age_source_kind`: `photo | sticker | null`
- `subject_age_detected_at`: timestamp

Notes:

- Do not edit old migrations.
- Add a new migration with the next number.

## Detection Requirements

1. Reuse existing subject-profile pipeline layer.
2. Add age detector output: `child | adult | unknown`.
3. If confidence is low, return `unknown`.
4. If detector fails/timeouts, do not block generation; use `unknown`.
5. Cache by source:
   - if session already has age profile for same `source_file_id + source_kind`, reuse it.

## Prompt Assembly Rules

For `generationType=style`:

1. Resolve source via `resolveGenerationSource`.
2. Resolve age profile for that source.
3. If `subject_age_group === child`:
   - inject child-safe identity lines into style prompt.
4. Else:
   - keep current identity line for style.

For non-style generation types:

- Keep current prompt behavior unchanged.

## Runtime Config

Add feature flag in `app_config`:

- `child_identity_protection_enabled` (default `false` for rollout)

Optional:

- `child_identity_confidence_min` (e.g. `0.75`)

## Logging Requirements

For each style generation, log:

- `generationType`
- `sourceKind`
- `sourceFileId` (truncated)
- `subject_age_group`
- `subject_age_confidence`
- `identity_rule_variant` (`default_identity` | `child_pose_only`)

No personal data in logs.

## Tests

1. `style + child` => child-safe lines are present.
2. `style + adult` => default identity line is present.
3. `style + unknown` => default identity line is present.
4. `emotion/motion` with child source => no prompt changes from this feature.
5. Retry flow preserves same age decision for same source.
6. Photo source and sticker source both supported.
7. Detector failure does not block generation.

## Done Criteria

- Child-safe lines appear only for `style + child`.
- No behavior regression in other generation types.
- Flag-based rollout works.
- Logs clearly show selected identity variant.
