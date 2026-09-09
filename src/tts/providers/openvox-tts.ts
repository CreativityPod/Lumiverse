import type { TtsProviderCapabilities } from "../param-schema";
import type { TtsVoiceListOptions } from "../provider";
import type { TtsRequest, TtsResponse, TtsVoice } from "../types";
import { OpenAICompatibleTtsProvider } from "./openai-compatible-tts";
import { fetchProviderJson } from "../../utils/provider-errors";

type UnknownRecord = Record<string, unknown>;

interface SynthesisQueueWaiter {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface SynthesisQueue {
  active: boolean;
  waiters: SynthesisQueueWaiter[];
}

/**
 * OpenVox accepts only one synthesis job at a time. Keep the queues at module
 * scope so separate provider instances targeting the same server serialize
 * against one another too.
 */
const synthesisQueues = new Map<string, SynthesisQueue>();

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function normalizedEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

function releaseSynthesisSlot(key: string, queue: SynthesisQueue): void {
  while (queue.waiters.length > 0) {
    const next = queue.waiters.shift()!;
    if (next.onAbort) {
      next.signal?.removeEventListener("abort", next.onAbort);
    }
    if (next.signal?.aborted) {
      next.reject(abortReason(next.signal));
      continue;
    }

    next.resolve(createRelease(key, queue));
    return;
  }

  queue.active = false;
  if (synthesisQueues.get(key) === queue) {
    synthesisQueues.delete(key);
  }
}

function createRelease(key: string, queue: SynthesisQueue): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSynthesisSlot(key, queue);
  };
}

function acquireSynthesisSlot(key: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }

  let queue = synthesisQueues.get(key);
  if (!queue) {
    queue = { active: false, waiters: [] };
    synthesisQueues.set(key, queue);
  }

  if (!queue.active) {
    queue.active = true;
    return Promise.resolve(createRelease(key, queue));
  }

  return new Promise<() => void>((resolve, reject) => {
    const waiter: SynthesisQueueWaiter = { signal, resolve, reject };
    if (signal) {
      waiter.onAbort = () => {
        const index = queue.waiters.indexOf(waiter);
        if (index === -1) return;
        queue.waiters.splice(index, 1);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    queue.waiters.push(waiter);
  });
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function firstString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function collection(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (!record) return [];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

/**
 * OpenVox local Text-to-Speech API.
 *
 * Speech synthesis uses the OpenAI-compatible `/audio/speech` shape, while
 * model and voice discovery use OpenVox's model-scoped endpoints.
 *
 * @see https://openvoxai.com/support#local-api
 */
export class OpenVoxTtsProvider extends OpenAICompatibleTtsProvider {
  readonly name = "openvox_tts";
  readonly displayName = "OpenVox TTS";

  readonly capabilities: TtsProviderCapabilities = {
    parameters: {
      speed: {
        type: "number",
        default: 1.0,
        min: 0.5,
        max: 2.0,
        step: 0.05,
        description: "Playback speed multiplier",
      },
      language: {
        type: "string",
        default: "en",
        description: "OpenVox language code used for speech synthesis",
        group: "advanced",
      },
    },
    apiKeyRequired: false,
    voiceListStyle: "dynamic",
    modelListStyle: "dynamic",
    // OpenVox streams SSE-wrapped base64 WAV data rather than raw audio bytes.
    // Use the buffered endpoint until that protocol has a dedicated adapter.
    supportsStreaming: false,
    supportedFormats: ["wav"],
    defaultUrl: "http://127.0.0.1:8000/v1",
    defaultFormat: "wav",
  };

  protected override buildBody(request: TtsRequest): Record<string, any> {
    return {
      ...super.buildBody(request),
      language: typeof request.parameters.language === "string" && request.parameters.language.trim()
        ? request.parameters.language.trim()
        : "en",
    };
  }

  override async synthesize(apiKey: string, apiUrl: string, request: TtsRequest): Promise<TtsResponse> {
    const queueKey = normalizedEndpoint(this.baseUrl(apiUrl));
    const release = await acquireSynthesisSlot(queueKey, request.signal);
    try {
      return await super.synthesize(apiKey, apiUrl, request);
    } finally {
      release();
    }
  }

  override async listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>> {
    const data = await fetchProviderJson<unknown>(
      this.displayName,
      "model listing",
      `${this.baseUrl(apiUrl)}/models`,
      { headers: this.headers(apiKey) },
    );

    const byId = new Map<string, { id: string; label: string }>();
    for (const entry of collection(data, ["data", "models"])) {
      if (typeof entry === "string" && entry.trim()) {
        const id = entry.trim();
        byId.set(id, { id, label: id });
        continue;
      }

      const record = asRecord(entry);
      if (!record) continue;
      const id = firstString(record, ["id", "model_id", "modelId", "model", "name"]);
      if (!id) continue;
      const label = firstString(record, ["display_name", "displayName", "label", "name"]) || id;
      byId.set(id, { id, label });
    }

    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  override async listVoices(
    apiKey: string,
    apiUrl: string,
    options?: TtsVoiceListOptions,
  ): Promise<TtsVoice[]> {
    const model = options?.model?.trim();
    if (!model) return [];

    const data = await fetchProviderJson<unknown>(
      this.displayName,
      "voice listing",
      `${this.baseUrl(apiUrl)}/models/${encodeURIComponent(model)}/voices`,
      { headers: this.headers(apiKey) },
    );

    const byId = new Map<string, TtsVoice>();
    for (const entry of collection(data, ["data", "voices"])) {
      if (typeof entry === "string" && entry.trim()) {
        const id = entry.trim();
        byId.set(id, { id, name: id });
        continue;
      }

      const record = asRecord(entry);
      if (!record) continue;
      const id = firstString(record, ["id", "voice_id", "voiceId", "name"]);
      if (!id) continue;

      const voice: TtsVoice = {
        id,
        name: firstString(record, ["display_name", "displayName", "label", "name"]) || id,
      };
      const language = firstString(record, ["language", "language_code", "languageCode", "locale"]);
      const gender = firstString(record, ["gender"]);
      if (language) voice.language = language;
      if (gender) voice.gender = gender;
      byId.set(id, voice);
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
}
