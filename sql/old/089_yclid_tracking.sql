-- Yandex Direct yclid tracking + conversion dedup
-- See: docs/13-02-yandex-direct-conversions.md

-- users: store yclid from start payload
ALTER TABLE users ADD COLUMN IF NOT EXISTS yclid text;
CREATE INDEX IF NOT EXISTS idx_users_yclid ON users(yclid);

-- transactions: conversion dedup fields
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS yandex_conversion_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS yandex_conversion_error text,
  ADD COLUMN IF NOT EXISTS yandex_conversion_attempts int DEFAULT 0;
