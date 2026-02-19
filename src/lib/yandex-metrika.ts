import axios from "axios";
import FormData from "form-data";
import { config } from "../config";

export interface ConversionParams {
  yclid: string;
  target: string;
  revenue: number;
  currency: string;
  orderId: string;
}

/** Target names for offline conversions — создать эти цели в Метрике. */
export const METRIKA_PURCHASE_TARGETS = {
  purchase: "purchase",
  purchase_try: "purchase_try",   // trial 5+5
  purchase_start: "purchase_start", // 10
  purchase_pop: "purchase_pop",     // 30
  purchase_pro: "purchase_pro",     // 100
  purchase_max: "purchase_max",     // 250
} as const;

/**
 * Target for offline conversion by pack (credits amount, trial flag).
 * Used in successful_payment to send pack-specific goals.
 */
export function getMetrikaTargetForPack(credits: number, trialOnly?: boolean): string {
  if (trialOnly && credits === 5) return METRIKA_PURCHASE_TARGETS.purchase_try;
  switch (credits) {
    case 10: return METRIKA_PURCHASE_TARGETS.purchase_start;
    case 30: return METRIKA_PURCHASE_TARGETS.purchase_pop;
    case 100: return METRIKA_PURCHASE_TARGETS.purchase_pro;
    case 250: return METRIKA_PURCHASE_TARGETS.purchase_max;
    default: return METRIKA_PURCHASE_TARGETS.purchase;
  }
}

/**
 * Send offline conversion to Yandex Metrika.
 * Non-blocking in caller — errors are caught and logged there.
 * See: docs/13-02-yandex-direct-conversions.md
 */
export async function sendYandexConversion(params: ConversionParams): Promise<void> {
  const counterId = config.yandexMetrikaCounterId;
  const token = config.yandexMetrikaToken;
  if (!counterId || !token) {
    console.log("[metrika] Skipped: YANDEX_METRIKA_COUNTER_ID or TOKEN not configured");
    return;
  }

  // CSV: колонка yclid (идентификатор клика Директа) — не UserId. Метрика привязывает конверсию к визиту по клику. См. https://yandex.ru/support/metrica/ru/data/offline-conversion-data
  const dateTimeUnix = Math.floor(Date.now() / 1000);
  const csv = [
    "yclid,Target,DateTime,Price,Currency",
    `${params.yclid},${params.target},${dateTimeUnix},${params.revenue},${params.currency}`,
  ].join("\n");

  const url = `https://api-metrika.yandex.net/management/v1/counter/${counterId}/offline_conversions/upload`;

  // API требует multipart/form-data с полем file, не сырой CSV
  const form = new FormData();
  form.append("file", Buffer.from(csv, "utf8"), { filename: "conversions.csv" });

  const response = await axios.post(url, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: `OAuth ${token}`,
    },
    timeout: 10000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  console.log("[metrika] API response status:", response.status, "data:", JSON.stringify(response.data).slice(0, 300));
}
