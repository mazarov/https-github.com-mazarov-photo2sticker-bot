import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

export const config = {
  appEnv: process.env.APP_ENV || "prod",  // "prod" | "test"
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  supabaseUrl: required("SUPABASE_SUPABASE_PUBLIC_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || "stickers",
  geminiApiKey: required("GEMINI_API_KEY"),
  openaiApiKey: process.env.OPENAI_API_KEY || "",

  // AI Chat assistant settings
  aiChatProvider: (process.env.AI_CHAT_PROVIDER || "gemini") as "gemini" | "openai",
  aiChatModel: process.env.AI_CHAT_MODEL || "",  // empty = use default per provider
  pixianUsername: required("PIXIAN_USERNAME"),
  pixianPassword: required("PIXIAN_PASSWORD"),
  port: Number(process.env.PORT || 3001),
  webhookPath: process.env.WEBHOOK_PATH || "/telegram/webhook",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
  jobPollIntervalMs: Number(process.env.JOB_POLL_INTERVAL_MS || 2000),
  botUsername: process.env.BOT_USERNAME || "",
  alertChannelId: process.env.ALERT_CHANNEL_ID || "",
  supportBotToken: process.env.SUPPORT_BOT_TOKEN || "",
  supportChannelId: process.env.SUPPORT_CHANNEL_ID || "",
  supportBotUsername: process.env.SUPPORT_BOT_USERNAME || "p2s_support_bot",
  adminIds: (process.env.ADMIN_IDS || "").split(",").map(id => parseInt(id.trim())).filter(id => !isNaN(id)),
  // Yandex Metrika offline conversions
  yandexMetrikaCounterId: process.env.YANDEX_METRIKA_COUNTER_ID || "",
  yandexMetrikaToken: process.env.YANDEX_METRIKA_TOKEN || "",
  // Geo-filter: whitelist of language prefixes that get free credits
  allowedLangPrefixes: [
    // Россия + Беларусь
    "ru", "be",
    // США + Англоязычные + Европа
    "en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "sk",
    "hu", "ro", "bg", "el", "sv", "da", "fi", "no", "et", "lv",
    "lt", "sl", "hr", "sr", "tr",
  ],
};
