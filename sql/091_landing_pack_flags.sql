-- 091_landing_pack_flags.sql
-- Лендинг: флаги для отображения паков на кластерных страницах и в блоке «Стили» (19-02).

-- Пак по content set показывается в Hero на кластерных (пилюли + карусель)
ALTER TABLE pack_content_sets
  ADD COLUMN IF NOT EXISTS cluster boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pack_content_sets.cluster IS 'Если true — пак этого content set показывается в Hero на всех кластерных страницах (пилюли). Файлы в Storage: pack/content/{id}/1..9.webp';

-- Стиль Hero на кластерных (в любой момент только один пресет с landing_cluster = true)
ALTER TABLE style_presets_v2
  ADD COLUMN IF NOT EXISTS landing_cluster boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN style_presets_v2.landing_cluster IS 'Если true — этот пресет задаёт стиль для Hero на кластерных страницах. Должен быть ровно один такой пресет.';

-- Ограничение: только один пресет с landing_cluster = true
CREATE UNIQUE INDEX IF NOT EXISTS idx_style_presets_v2_landing_cluster_single
  ON style_presets_v2 ((true))
  WHERE landing_cluster = true;

-- Пресет показывается карточкой в блоке «Стили» на кластерных и имеет страницу подстиля
ALTER TABLE style_presets_v2
  ADD COLUMN IF NOT EXISTS landing boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN style_presets_v2.landing IS 'Если true — пресет выводится карточкой в блоке «Стили» на кластерных и имеет страницу /style/[group]/[substyle]. Пак в Storage: pack/style/{id}/1..9.webp';
