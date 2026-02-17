-- Проверка пользователя: yclid, UTM, env (для отладки Метрики)
-- Подставь свой telegram_id или user id в условие WHERE

SELECT
  id,
  telegram_id,
  username,
  lang,
  env,
  credits,
  has_purchased,
  start_payload,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_content,
  yclid,
  created_at,
  updated_at
FROM users
WHERE telegram_id = 42269230
   OR id = '9982861b-8b1a-4789-a638-0c7fb44c13d6'::uuid;
