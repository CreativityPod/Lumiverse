/**
 * In-flight native generation registry.
 *
 * Built-in ImgGen jobs run in the primary lane (`namespace === null`). Callers
 * such as extensions may opt into a named lane so their jobs neither supersede
 * ImgGen jobs for the same chat nor share its scene-change cache. Named lanes
 * yield to ImgGen on a shared ComfyUI server: they refuse to start while an
 * ImgGen job is running there, and ImgGen queues ahead of their pending work.
 */

export interface ActiveGenerationJob {
  controller: AbortController;
  startedAt: number;
  namespace: string | null;
  /** Normalized ComfyUI server identity, or null for non-workflow providers. */
  serverKey: string | null;
}

export const IMAGE_GEN_BUSY_PREFIX = "IMAGE_GEN_BUSY:";

const activeJobs = new Map<string, ActiveGenerationJob>();

export function normalizeJobNamespace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Primary-lane keys keep the historical `${userId}:${chatId}` shape. */
export function generationJobKey(userId: string, chatId: string, namespace: string | null): string {
  return namespace ? `${userId}:${chatId}:${namespace}` : `${userId}:${chatId}`;
}

/**
 * Identify the ComfyUI server a connection submits workflows to. Two profiles
 * pointing at the same host share one queue, so they share one key.
 */
export function comfyServerKey(
  connection: { provider: string; api_url?: string | null },
): string | null {
  if (connection.provider !== "comfyui" && connection.provider !== "swarmui") return null;
  const raw = connection.api_url
    || (connection.provider === "swarmui" ? "http://localhost:7801" : "http://localhost:8188");
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

export function getActiveGenerationJob(key: string): ActiveGenerationJob | undefined {
  return activeJobs.get(key);
}

export function setActiveGenerationJob(key: string, job: ActiveGenerationJob): void {
  activeJobs.set(key, job);
}

/** Only clears the entry if it still belongs to `controller`. */
export function clearActiveGenerationJob(key: string, controller: AbortController): void {
  if (activeJobs.get(key)?.controller === controller) activeJobs.delete(key);
}

function hasJobOn(serverKey: string, primary: boolean): boolean {
  for (const job of activeJobs.values()) {
    if (job.serverKey !== serverKey || job.controller.signal.aborted) continue;
    if ((job.namespace === null) === primary) return true;
  }
  return false;
}

/** True while a built-in ImgGen job is using this ComfyUI server. */
export function isPrimaryGenerationBusyOn(serverKey: string | null): boolean {
  return serverKey !== null && hasJobOn(serverKey, true);
}

/** True while any named-lane (e.g. extension video) job is using this server. */
export function hasNamespacedGenerationOn(serverKey: string | null): boolean {
  return serverKey !== null && hasJobOn(serverKey, false);
}

/** Test hook. */
export function resetActiveGenerationJobs(): void {
  activeJobs.clear();
}
