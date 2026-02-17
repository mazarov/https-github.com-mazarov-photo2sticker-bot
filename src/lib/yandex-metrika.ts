import axios from "axios";
import { config } from "../config";

export interface ConversionParams {
  yclid: string;
  target: string;
  revenue: number;
  currency: string;
  orderId: string;
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

  const datetime = new Date().toISOString().replace("T", " ").slice(0, 19);
  const csv = [
    "UserId,Target,DateTime,Price,Currency",
    `${params.yclid},${params.target},${datetime},${params.revenue},${params.currency}`,
  ].join("\n");

  const url = `https://api-metrika.yandex.net/management/v1/counter/${counterId}/offline_conversions/upload`;

  const response = await axios.post(url, csv, {
    headers: {
      Authorization: `OAuth ${token}`,
      "Content-Type": "application/x-csv-with-header",
    },
    timeout: 10000,
  });

  console.log("[metrika] API response status:", response.status, "data:", JSON.stringify(response.data).slice(0, 200));
}
