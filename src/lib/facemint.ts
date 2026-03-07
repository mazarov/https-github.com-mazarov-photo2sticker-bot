import axios from "axios";
import { config } from "../config";

type FaceSwapType = "image" | "gif" | "video";

export interface FacemintSwapPair {
  from_face?: string;
  to_face: string;
}

export interface FacemintCreateTaskParams {
  type: FaceSwapType;
  media_url: string;
  swap_list: FacemintSwapPair[];
  start_time?: number;
  end_time?: number;
  resolution?: number;
  enhance?: number;
  watermark?: string;
  callback_url?: string;
  nsfw_check?: number;
  face_recognition?: number;
  face_detection?: number;
}

interface FacemintCreateTaskResponse {
  code: number;
  info?: string;
  data?: {
    taskId: string;
    price?: number;
  };
}

interface FacemintTaskInfoResponse {
  code: number;
  info?: string;
  data?: FacemintTaskInfo;
}

export interface FacemintTaskInfo {
  id: string;
  state: -1 | 0 | 1 | 2 | 3;
  price?: number;
  process?: number;
  result?: {
    file_url?: string;
    thumb_url?: string;
  };
}

function getHeaders(): Record<string, string> {
  return {
    "x-api-key": config.facemintApiKey,
    "Content-Type": "application/json",
  };
}

/** Facemint API requires valid callback_url and watermark (non-empty). We use polling, so callback is unused. */
function getDefaultCallbackUrl(): string {
  if (config.facemintCallbackUrl?.trim()) return config.facemintCallbackUrl.trim();
  const base = (config.publicBaseUrl || "https://photo2sticker.ru").replace(/\/+$/, "");
  return `${base}/webhook/facemint`;
}

export async function createFaceSwapTask(params: FacemintCreateTaskParams): Promise<{ taskId: string; price?: number }> {
  const url = `${config.facemintBaseUrl.replace(/\/+$/, "")}/create-face-swap-task`;
  const wm = (config.facemintWatermark ?? "").trim() || " ";
  const payload: Record<string, unknown> = {
    start_time: 0,
    end_time: 0,
    resolution: 1,
    enhance: 1,
    nsfw_check: 0,
    face_recognition: 0.8,
    face_detection: 0.25,
    watermark: wm,
    callback_url: getDefaultCallbackUrl(),
    ...params,
  };

  if (typeof payload.callback_url === "string" && payload.callback_url.trim() === "") {
    payload.callback_url = getDefaultCallbackUrl();
  }

  if (Array.isArray(payload.swap_list)) {
    payload.swap_list = payload.swap_list.map((item: unknown) => {
      const pair = (item ?? {}) as FacemintSwapPair;
      if (typeof pair.from_face === "string" && pair.from_face.trim() === "") {
        const { from_face, ...rest } = pair;
        return rest;
      }
      return pair;
    });
  }

  console.log("[Facemint] create-face-swap-task request", { url, payload });

  const { data } = await axios.post<FacemintCreateTaskResponse>(url, payload, {
    headers: getHeaders(),
    timeout: 30_000,
  });

  console.log("[Facemint] create-face-swap-task response", {
    code: data?.code,
    info: data?.info,
    taskId: data?.data?.taskId,
    price: data?.data?.price,
    fullResponse: JSON.stringify(data),
  });

  if (data?.code !== 0 || !data?.data?.taskId) {
    throw new Error(`Facemint create task failed: code=${data?.code ?? "unknown"} info=${data?.info ?? "no_info"}`);
  }

  return {
    taskId: data.data.taskId,
    price: data.data.price,
  };
}

export async function getFaceSwapTaskInfo(
  taskId: string,
  options?: { logRequest?: boolean }
): Promise<FacemintTaskInfo> {
  const url = `${config.facemintBaseUrl.replace(/\/+$/, "")}/get-task-info`;
  const body = { task_id: taskId };
  if (options?.logRequest) {
    console.log("[Facemint] get-task-info request", { url, body });
  }
  const { data } = await axios.post<FacemintTaskInfoResponse>(
    url,
    body,
    { headers: getHeaders(), timeout: 30_000 }
  );

  if (options?.logRequest) {
    console.log("[Facemint] get-task-info response", {
      taskId,
      state: data?.data?.state,
      process: data?.data?.process,
      fullResponse: JSON.stringify(data),
    });
  }
  if (data?.data && (data.data.state === -1 || data.data.state === 2)) {
    console.log("[Facemint] get-task-info failure state", {
      taskId,
      state: data.data.state,
      fullResponse: JSON.stringify(data),
    });
  }

  if (data?.code !== 0 || !data?.data) {
    throw new Error(`Facemint get task failed: code=${data?.code ?? "unknown"} info=${data?.info ?? "no_info"}`);
  }

  return data.data;
}

export async function waitForFaceSwapTask(
  taskId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<FacemintTaskInfo> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  let lastState = 0;
  let pollCount = 0;

  while (Date.now() < deadline) {
    const task = await getFaceSwapTaskInfo(taskId, { logRequest: pollCount === 0 });
    lastState = task.state;
    pollCount++;

    if (task.state === 3) return task;
    if (task.state === -1 || task.state === 2) {
      console.log("[Facemint] task failed, full task info", JSON.stringify(task, null, 2));
      throw new Error(`Facemint task finished with non-success state=${task.state}`);
    }

    if (pollCount % 10 === 0) {
      console.log("[Facemint] polling", { taskId, state: task.state, process: task.process, pollCount });
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const finalTask = await getFaceSwapTaskInfo(taskId).catch(() => null);
  const stateInfo = finalTask ? ` lastState=${finalTask.state} process=${finalTask.process}` : "";
  throw new Error(`Facemint task timeout after ${timeoutMs}ms${stateInfo}`);
}
