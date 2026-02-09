import { supabase } from "./supabase";

// Cache for texts (refreshed every 5 minutes)
let textsCache: Map<string, string> = new Map();
let textsCacheTime = 0;
const TEXTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fallback texts (used if DB is unavailable)
const fallbackTexts: Record<string, Record<string, string>> = {
  ru: {
    "start.greeting_new": "Привет! 🎨\n\nЯ превращаю фото в крутые стикеры.\n\n💡 Бонус +2 кредита к первой покупке!\n\nПришли фото, чтобы начать.",
    "start.greeting_return": "С возвращением! 🎨\n\nТвой баланс: {credits} кредитов.\n\nПришли фото, из которого сделать стикер.",
    "start.need_start": "Нажми /start чтобы начать.",
    "photo.ask_style": "Отлично! Теперь выбери стиль стикера из вариантов ниже или напиши свой текстом.",
    "photo.need_photo": "Сначала пришли фото.",
    "photo.processing": "🔄 Обрабатываю запрос...",
    "photo.invalid_style": "❌ Не удалось распознать стиль.\n\nОпиши визуальный стиль стикера, например:\n• аниме\n• мультяшный\n• симпсоны\n• 3D\n• пиксель арт\n• chibi, грустный",
    "photo.not_enough_credits": "❌ Недостаточно кредитов!\n\nНужно: {needed} кредит(ов)\nУ тебя: {balance} кредит(ов)\n\nПополни баланс, чтобы продолжить.",
    "photo.generation_started": "✨ Принял! Генерирую стикер, это займет немного времени...",
    "photo.generation_continue": "✨ Продолжаю генерацию стикера...",
    "payment.balance": "💳 Ваш баланс: {credits} кредитов\n\n1 стикер = 1 кредит\nПополните баланс через Telegram Stars ⭐",
    "payment.success": "✅ Оплата прошла успешно!\n\nНачислено: {amount} кредитов\nНовый баланс: {balance} кредитов",
    "payment.need_more": "Для генерации нужно ещё {needed} кредит(ов).\nПополни баланс или отправь /start для новой сессии.",
    "payment.canceled": "Отменено. Можешь изменить описание стиля или пополнить баланс позже.",
    "payment.invalid_pack": "Неверный пакет.",
    "payment.error_create": "Ошибка создания платежа. Попробуй позже.",
    "payment.error_invoice": "Ошибка отправки счёта. Попробуй позже.",
    "payment.transaction_not_found": "Транзакция не найдена или уже обработана.",
    "payment.invoice_title": "{credits} кредитов",
    "payment.invoice_description": "Пополнение баланса на {credits} кредитов",
    "payment.invoice_label": "Кредиты",
    "balance.info": "💰 Ваш баланс: {credits} кредитов\n\n1 кредит = 1 стикер",
    "btn.top_up": "Пополнить баланс",
    "processing.done": "Готово! Вот ваш стикерпак: {link}",
    "processing.error": "❌ Произошла ошибка при генерации стикера.\n\nКредиты возвращены на баланс.\nПопробуй ещё раз: /start",
    "btn.cancel": "❌ Отмена",
    "btn.canceled": "Отменено",
    "btn.add_to_pack": "➕ Добавить в пак",
    "btn.change_style": "🎨 Изменить стиль",
    "btn.change_emotion": "😊 Изменить эмоцию",
    "btn.change_motion": "🏃 Изменить движение",
    "sticker.added_to_pack": "Стикер добавлен в пак! 🎉\n{link}",
    "emotion.choose": "Выберите эмоцию для стикера 😊",
    "emotion.custom_prompt": "Опишите желаемую эмоцию ✍️",
    "motion.choose": "🏃 Выберите движение:",
    "motion.custom_prompt": "✍️ Опишите желаемое движение или позу:",
    "style.custom_prompt": "✍️ Опишите желаемый стиль стикера:",
    "error.no_stickers_added": "Вы не добавили ни одного стикера 🧩",
    "error.technical": "Что-то пошло не так. Попробуйте повторить попытку позже ⚠️",
    "support.message": "💬 Если у вас есть вопросы, предложения или проблемы — напишите напрямую:",
    "support.button": "💬 Написать в поддержку",
    "menu.help": "📷 Отправь фото — получи стикер\n💰 Каждый стикер = 1 кредит\n🎨 Выбирай стили и эмоции\n\nВопросы? @p2s_support_bot",
    "btn.add_text": "✏️ Добавить текст",
    "btn.toggle_border": "🔲 Обводка",
    "text.prompt": "Введите текст для стикера:",
    "progress.step1": "🔍 Анализирую фото... (1/7)",
    "progress.step2": "🎨 Подбираю стиль... (2/7)",
    "progress.step3": "✨ Генерирую изображение... (3/7)",
    "progress.step4": "🖼 Обрабатываю результат... (4/7)",
    "progress.step5": "✂️ Удаляю фон... (5/7)",
    "progress.step6": "📐 Оптимизирую размер... (6/7)",
    "progress.step7": "📦 Подготавливаю стикер... (7/7)",
    "sticker.pack_title": "Мои стикеры",
    "style.example_title": "Пример стиля {style}",
    "style.no_examples": "Примеров пока нет",
    "style.no_more_examples": "Больше примеров нет",
    "btn.example": "Пример",
    "btn.more": "Ещё",
    "btn.back_to_styles": "← Назад",
    "style.custom_prompt_v2": "✍️ Опиши желаемый стиль:\n\nНапример:\n• в стиле комиксов Marvel\n• как персонаж Наруто\n• в стиле советского плаката\n• пиксельный ретро-стиль",
    "btn.custom_style": "✍️ Свой стиль",
    // Paywall
    "paywall.message": "Стикер почти готов! 🔥\n\nРазблокируй генерацию, купив пакет кредитов.\n\n🎁 Бонус: +2 кредита к первой покупке!",
    "paywall.bonus_applied": "🎁 Бонус +2 кредита начислен!",
  },
  en: {
    "start.greeting_new": "Hello! 🎨\n\nI turn photos into cool stickers.\n\n💡 Bonus +2 credits with your first purchase!\n\nSend a photo to start.",
    "start.greeting_return": "Welcome back! 🎨\n\nYour balance: {credits} credits.\n\nSend a photo to make a sticker.",
    "start.need_start": "Press /start to begin.",
    "photo.ask_style": "Great! Now choose a sticker style from the options below or describe your own.",
    "photo.need_photo": "Send a photo first.",
    "photo.processing": "🔄 Processing request...",
    "photo.invalid_style": "❌ Could not recognize the style.\n\nDescribe a visual style, for example:\n• anime\n• cartoon\n• simpsons\n• 3D\n• pixel art\n• chibi, sad",
    "photo.not_enough_credits": "❌ Not enough credits!\n\nNeeded: {needed} credit(s)\nYou have: {balance} credit(s)\n\nTop up your balance to continue.",
    "photo.generation_started": "✨ Got it! Generating sticker, it will take a moment...",
    "photo.generation_continue": "✨ Continuing sticker generation...",
    "payment.balance": "💳 Your balance: {credits} credits\n\n1 sticker = 1 credit\nTop up via Telegram Stars ⭐",
    "payment.success": "✅ Payment successful!\n\nAdded: {amount} credits\nNew balance: {balance} credits",
    "payment.need_more": "You need {needed} more credit(s) for generation.\nTop up or send /start for a new session.",
    "payment.canceled": "Canceled. You can change the style description or top up later.",
    "payment.invalid_pack": "Invalid package.",
    "payment.error_create": "Error creating payment. Try again later.",
    "payment.error_invoice": "Error sending invoice. Try again later.",
    "payment.transaction_not_found": "Transaction not found or already processed.",
    "payment.invoice_title": "{credits} credits",
    "payment.invoice_description": "Top up balance with {credits} credits",
    "payment.invoice_label": "Credits",
    "balance.info": "💰 Your balance: {credits} credits\n\n1 credit = 1 sticker",
    "btn.top_up": "Top up balance",
    "processing.done": "Done! Here's your sticker pack: {link}",
    "processing.error": "❌ An error occurred during sticker generation.\n\nCredits have been refunded.\nTry again: /start",
    "btn.cancel": "❌ Cancel",
    "btn.canceled": "Canceled",
    "btn.add_to_pack": "➕ Add to pack",
    "btn.change_style": "🎨 Change style",
    "btn.change_emotion": "😊 Change emotion",
    "btn.change_motion": "🏃 Change pose",
    "sticker.added_to_pack": "Sticker added to pack! 🎉\n{link}",
    "emotion.choose": "Choose an emotion for the sticker 😊",
    "emotion.custom_prompt": "Describe the desired emotion ✍️",
    "motion.choose": "🏃 Choose a pose:",
    "motion.custom_prompt": "✍️ Describe the desired pose or action:",
    "style.custom_prompt": "✍️ Describe the desired sticker style:",
    "error.no_stickers_added": "You haven't added any stickers 🧩",
    "error.technical": "Something went wrong. Please try again later ⚠️",
    "support.message": "💬 If you have questions, suggestions or issues — write directly:",
    "support.button": "💬 Contact support",
    "menu.help": "📷 Send photo — get sticker\n💰 Each sticker = 1 credit\n🎨 Choose styles and emotions\n\nQuestions? @p2s_support_bot",
    "btn.add_text": "✏️ Add text",
    "btn.toggle_border": "🔲 Border",
    "text.prompt": "Enter text for the sticker:",
    "progress.step1": "🔍 Analyzing photo... (1/7)",
    "progress.step2": "🎨 Selecting style... (2/7)",
    "progress.step3": "✨ Generating image... (3/7)",
    "progress.step4": "🖼 Processing result... (4/7)",
    "progress.step5": "✂️ Removing background... (5/7)",
    "progress.step6": "📐 Optimizing size... (6/7)",
    "progress.step7": "📦 Preparing sticker... (7/7)",
    "sticker.pack_title": "My Stickers",
    "style.example_title": "Example of {style} style",
    "style.no_examples": "No examples yet",
    "style.no_more_examples": "No more examples",
    "btn.example": "Example",
    "btn.more": "More",
    "btn.back_to_styles": "← Back",
    // Styles v2
    "style.custom_prompt_v2": "✍️ Describe the style you want:\n\nExamples:\n• Marvel comics style\n• like a Naruto character\n• Soviet poster style\n• pixel retro style",
    "btn.custom_style": "✍️ Custom style",
    // Paywall
    "paywall.message": "Sticker almost ready! 🔥\n\nUnlock generation by purchasing a credit package.\n\n🎁 Bonus: +2 credits with your first purchase!",
    "paywall.bonus_applied": "🎁 Bonus +2 credits applied!",
  },
};

/**
 * Load all texts for a language from DB into cache
 */
async function loadTextsToCache(lang: string): Promise<void> {
  try {
    const { data } = await supabase
      .from("bot_texts_new")
      .select("key, text")
      .eq("lang", lang);

    if (data && data.length > 0) {
      for (const row of data) {
        textsCache.set(`${lang}:${row.key}`, row.text);
      }
    }
    textsCacheTime = Date.now();
  } catch (err) {
    console.error("Failed to load texts from DB:", err);
  }
}

/**
 * Get localized text by key
 * @param lang - Language code (ru, en)
 * @param key - Text key (e.g., "start.greeting_new")
 * @param replacements - Object with placeholder replacements
 */
export async function getText(
  lang: string,
  key: string,
  replacements?: Record<string, string | number>
): Promise<string> {
  const normalizedLang = lang === "ru" ? "ru" : "en";
  const cacheKey = `${normalizedLang}:${key}`;

  // Refresh cache if expired
  if (Date.now() - textsCacheTime > TEXTS_CACHE_TTL) {
    await loadTextsToCache(normalizedLang);
  }

  // Try to get from cache
  let text = textsCache.get(cacheKey);

  // If not in cache, try to load from DB
  if (!text) {
    const { data } = await supabase
      .from("bot_texts_new")
      .select("text")
      .eq("key", key)
      .eq("lang", normalizedLang)
      .maybeSingle();

    if (data?.text) {
      text = data.text;
      textsCache.set(cacheKey, data.text);
    }
  }

  // Fallback to hardcoded texts
  if (!text) {
    text = fallbackTexts[normalizedLang]?.[key] || fallbackTexts["en"]?.[key] || `[${key}]`;
  }

  // Replace placeholders
  if (replacements) {
    for (const [k, v] of Object.entries(replacements)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }

  // Replace escaped newlines
  text = text.replace(/\\n/g, "\n");

  return text;
}

/**
 * Preload texts for common languages
 */
export async function preloadTexts(): Promise<void> {
  await loadTextsToCache("ru");
  await loadTextsToCache("en");
}
