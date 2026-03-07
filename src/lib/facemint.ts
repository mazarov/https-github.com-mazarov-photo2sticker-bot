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

export async function createFaceSwapTask(params: FacemintCreateTaskParams): Promise<{ taskId: string; price?: number }> {
  const url = `${config.facemintBaseUrl.replace(/\/+$/, "")}/create-face-swap-task`;
  const payload = {
    start_time: 0,
    end_time: 0,
    resolution: 1,
    enhance: 1,
    watermark: "",
    callback_url: "",
    nsfw_check: 0,
    face_recognition: 0.8,
    face_detection: 0.25,
    ...params,
  };
  const { data } = await axios.post<FacemintCreateTaskResponse>(url, payload, {
    headers: getHeaders(),
    timeout: 30_000,
  });

  if (data?.code !== 0 || !data?.data?.taskId) {
    throw new Error(`Facemint create task failed: code=${data?.code ?? "unknown"} info=${data?.info ?? "no_info"}`);
  }

  return {
    taskId: data.data.taskId,
    price: data.data.price,
  };
}

export async function getFaceSwapTaskInfo(taskId: string): Promise<FacemintTaskInfo> {
  const url = `${config.facemintBaseUrl.replace(/\/+$/, "")}/get-task-info`;
  const { data } = await axios.post<FacemintTaskInfoResponse>(
    url,
    { task_id: taskId },
    { headers: getHeaders(), timeout: 30_000 }
  );

  if (data?.code !== 0 || !data?.data) {
    throw new Error(`Facemint get task failed: code=${data?.code ?? "unknown"} info=${data?.info ?? "no_info"}`);
  }

  return data.data;
}

export async function waitForFaceSwapTask(
  taskId: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<FacemintTaskInfo> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const task = await getFaceSwapTaskInfo(taskId);
    if (task.state === 3) return task;
    if (task.state === -1 || task.state === 2) {
      throw new Error(`Facemint task finished with non-success state=${task.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Facemint task timeout after ${timeoutMs}ms`);
}
