import { openWebSocket } from "./ws-helpers"
import { parseProviderErrorBody, readBoundedText } from "../../utils/provider-errors"

const MAX_COMFY_OUTPUT_BYTES = 250 * 1024 * 1024

export interface ComfyRunnerOptions {
  label: string
  // Sent as Cookie header on every HTTP + WS call. Used for SwarmUI's
  // /ComfyBackendDirect proxy when the instance is auth-gated.
  cookie?: string
  wsTimeoutMs?: number
}

export type ComfyStreamEvent =
  | { type: "progress"; step: number; totalSteps: number }
  | { type: "executing"; nodeId: string }
  | { type: "preview"; imageBase64: string }

export interface ComfyRunnerResult {
  mediaType: "image" | "video"
  mimeType: string
  filename: string
  imageDataUrl?: string
  mediaData?: Uint8Array
}

export interface ComfyMediaResult {
  mediaType: "image" | "video"
  filename: string
  subfolder: string
  type: string
}

function buildHeaders(cookie?: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) }
  if (cookie) h.Cookie = cookie
  return h
}

export function buildComfyMediaViewUrl(baseUrl: string, media: ComfyMediaResult): string {
  return `${baseUrl}/view?filename=${encodeURIComponent(media.filename)}&subfolder=${encodeURIComponent(media.subfolder)}&type=${encodeURIComponent(media.type)}`
}

/** @deprecated Use buildComfyMediaViewUrl. */
export const buildComfyImageViewUrl = buildComfyMediaViewUrl

/**
 * Upload a source image to ComfyUI's input directory so a LoadImage node can
 * reference it by filename (img2img). Stock ComfyUI's LoadImage cannot accept
 * base64 inline, so the image must be uploaded first via `POST /upload/image`.
 *
 * Returns the server-assigned `{ name, subfolder }` — ComfyUI may rename on
 * collision, so callers must use the returned name, not the one they sent.
 */
export async function uploadComfyImage(
  baseUrl: string,
  image: { data: string; mimeType?: string; filename?: string },
  opts: { cookie?: string; signal?: AbortSignal },
): Promise<{ name: string; subfolder: string }> {
  baseUrl = baseUrl.replace(/\/+$/, "")
  const bytes = Buffer.from(image.data, "base64")
  const mime = image.mimeType || "image/png"
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("webp") ? "webp" : "png"
  const filename = image.filename || `lumiverse-init-${crypto.randomUUID()}.${ext}`

  const form = new FormData()
  form.append("image", new Blob([bytes], { type: mime }), filename)
  form.append("type", "input")
  form.append("overwrite", "true")

  const res = await fetch(`${baseUrl}/upload/image`, {
    method: "POST",
    headers: opts.cookie ? { Cookie: opts.cookie } : undefined,
    body: form,
    signal: opts.signal,
  })

  if (!res.ok) {
    const rawBody = await readBoundedText(res)
    const parsed = parseProviderErrorBody(rawBody)
    const detail = parsed.detail || parsed.code || String(res.status)
    throw new Error(`ComfyUI rejected image upload: ${detail}`)
  }

  const data = (await res.json()) as { name?: string; subfolder?: string }
  if (!data?.name) throw new Error("ComfyUI /upload/image returned no filename")
  return { name: data.name, subfolder: typeof data.subfolder === "string" ? data.subfolder : "" }
}

function normalizeComfyOutputEntry(value: unknown, mediaType: "image" | "video"): ComfyMediaResult | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.filename !== "string" || !record.filename.trim()) return null
  return {
    mediaType,
    filename: record.filename,
    subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
    type: typeof record.type === "string" ? record.type : "output",
  }
}

function isMp4Output(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const filename = typeof record.filename === "string" ? record.filename.toLowerCase() : ""
  const format = typeof record.format === "string" ? record.format.toLowerCase() : ""
  return filename.endsWith(".mp4") || format === "video/mp4" || format.includes("mp4")
}

/**
 * Resolve a final workflow output. Video Helper Suite commonly reports MP4
 * files under `gifs`; other nodes use `videos`, while ordinary Save Image
 * nodes use `images`. A real MP4 wins over preview/still outputs so video
 * workflows do not accidentally return their first frame.
 */
export function findFirstComfyMediaResult(
  outputs: Record<string, any> | null | undefined,
): ComfyMediaResult | null {
  if (!outputs || typeof outputs !== "object") return null

  for (const nodeOutput of Object.values(outputs) as any[]) {
    for (const key of ["videos", "gifs", "images"] as const) {
      const candidates = Array.isArray(nodeOutput?.[key]) ? nodeOutput[key] : []
      const video = candidates.find(isMp4Output)
      const normalized = normalizeComfyOutputEntry(video, "video")
      if (normalized) return normalized
    }
  }

  for (const nodeOutput of Object.values(outputs) as any[]) {
    if (!Array.isArray(nodeOutput?.images) || nodeOutput.images.length === 0) continue
    const image = nodeOutput.images.find((entry: unknown) => !isMp4Output(entry))
    const normalized = normalizeComfyOutputEntry(image, "image")
    if (normalized) return normalized
  }
  return null
}

/** @deprecated Use findFirstComfyMediaResult. */
export function findFirstComfyImageResult(
  outputs: Record<string, any> | null | undefined,
): ComfyMediaResult | null {
  const result = findFirstComfyMediaResult(outputs)
  return result?.mediaType === "image" ? result : null
}

function logOutputsShape(label: string, outputs: Record<string, any>, promptId: string): void {
  try {
    const summary: Record<string, { keys: string[]; imageCount: number; videoCount: number; gifCount: number; outputShape?: any }> = {}
    for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
      const keys = nodeOutput && typeof nodeOutput === "object" ? Object.keys(nodeOutput) : []
      const images = Array.isArray(nodeOutput?.images) ? nodeOutput.images : []
      const videos = Array.isArray(nodeOutput?.videos) ? nodeOutput.videos : []
      const gifs = Array.isArray(nodeOutput?.gifs) ? nodeOutput.gifs : []
      const firstOutput = videos[0] ?? gifs[0] ?? images[0]
      summary[nodeId] = {
        keys,
        imageCount: images.length,
        videoCount: videos.length,
        gifCount: gifs.length,
        ...(firstOutput ? { outputShape: Object.keys(firstOutput) } : {}),
      }
    }
    console.error(
      "[%s] No supported media found in outputs. promptId=%s nodeCount=%d outputShape=%j",
      label, promptId, Object.keys(outputs).length, summary,
    )
  } catch {
    console.error("[%s] No supported media found in outputs and failed to log shape. promptId=%s", label, promptId)
  }
}

function isMp4Bytes(bytes: Uint8Array): boolean {
  const scanEnd = Math.min(bytes.byteLength - 3, 64)
  for (let i = 4; i < scanEnd; i++) {
    if (bytes[i] === 0x66 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x79 && bytes[i + 3] === 0x70) {
      return true
    }
  }
  return false
}

async function readMediaBytesCapped(response: Response, label: string): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_COMFY_OUTPUT_BYTES) {
    throw new Error(`${label} output exceeds the 250 MB generation limit`)
  }
  if (!response.body) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_COMFY_OUTPUT_BYTES) {
      try { await reader.cancel() } catch {}
      throw new Error(`${label} output exceeds the 250 MB generation limit`)
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export async function* executeComfyWorkflowStream(
  baseUrl: string,
  workflow: Record<string, any>,
  signal: AbortSignal | undefined,
  opts: ComfyRunnerOptions,
): AsyncGenerator<ComfyStreamEvent, ComfyRunnerResult, unknown> {
  const { label, cookie } = opts
  // Trailing slashes on user-provided apiUrl cause `//ws`, `//prompt`, etc.
  // The WS handshake then returns a normal HTTP response and Bun reports
  // "Expected 101 status code". Strip once at the boundary.
  baseUrl = baseUrl.replace(/\/+$/, "")
  const clientId = crypto.randomUUID()

  const wsUrl = baseUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`
  console.debug("[%s] Opening WS to %s (clientId=%s)", label, wsUrl, clientId)
  const ws = await openWebSocket(wsUrl, {
    label,
    timeoutMs: opts.wsTimeoutMs ?? 15_000,
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  console.debug("[%s] WS connected (clientId=%s)", label, clientId)

  const queueRes = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: buildHeaders(cookie, { "Content-Type": "application/json" }),
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    signal,
  })

  if (!queueRes.ok) {
    ws.close()
    const rawBody = await readBoundedText(queueRes)
    const parsed = parseProviderErrorBody(rawBody)
    const detail = parsed.detail || parsed.code || String(queueRes.status)
    throw new Error(`${label} rejected workflow: ${detail}`)
  }

  const queueData = (await queueRes.json()) as { prompt_id: string }
  const promptId = queueData.prompt_id
  console.debug("[%s] Prompt queued (promptId=%s, clientId=%s)", label, promptId, clientId)

  const abortHandler = () => {
    fetch(`${baseUrl}/interrupt`, {
      method: "POST",
      headers: buildHeaders(cookie),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  signal?.addEventListener("abort", abortHandler, { once: true })

  try {
    for await (const event of wsEventStream(ws, promptId, signal)) {
      if (event.type === "complete") {
        break
      } else if (event.type === "error") {
        throw new Error(`${label} execution error: ${event.message}`)
      } else if (event.type === "progress") {
        yield { type: "progress", step: event.value, totalSteps: event.max }
      } else if (event.type === "executing") {
        yield { type: "executing", nodeId: event.nodeId }
      } else if (event.type === "preview") {
        yield { type: "preview", imageBase64: event.imageBase64 }
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler)
    ws.close()
  }

  console.debug("[%s] Fetching history for promptId=%s", label, promptId)
  const historyRes = await fetch(`${baseUrl}/history/${promptId}`, {
    headers: buildHeaders(cookie),
    signal,
  })
  if (!historyRes.ok) {
    throw new Error(`${label} history fetch failed: ${historyRes.status}`)
  }

  const history = (await historyRes.json()) as Record<string, any>
  const outputs = history[promptId]?.outputs
  if (!outputs) {
    const historyKeys = Object.keys(history)
    const entryKeys = history[promptId] ? Object.keys(history[promptId]) : []
    console.error("[%s] No outputs in history. promptId=%s, historyKeys=%j, entryKeys=%j", label, promptId, historyKeys, entryKeys)
    throw new Error(`No outputs in ${label} history`)
  }

  const mediaResult = findFirstComfyMediaResult(outputs)
  if (!mediaResult) {
    logOutputsShape(label, outputs, promptId)
    throw new Error(`No supported image or MP4 output found in ${label} results`)
  }
  console.debug("[%s] Found %s result: filename=%s subfolder=%s type=%s", label, mediaResult.mediaType, mediaResult.filename, mediaResult.subfolder, mediaResult.type)

  const mediaUrl = buildComfyMediaViewUrl(baseUrl, mediaResult)
  const mediaRes = await fetch(mediaUrl, { headers: buildHeaders(cookie), signal })
  if (!mediaRes.ok) throw new Error(`Failed to fetch ${label} output media: ${mediaRes.status}`)

  const mediaBuffer = await readMediaBytesCapped(mediaRes, label)
  if (mediaResult.mediaType === "video") {
    if (!isMp4Bytes(mediaBuffer)) {
      throw new Error(`${label} returned a video output that is not a valid MP4 file`)
    }
    return {
      mediaType: "video",
      mimeType: "video/mp4",
      filename: mediaResult.filename,
      mediaData: mediaBuffer,
    }
  }

  const mimeType = mediaRes.headers.get("content-type") || "image/png"
  const base64 = Buffer.from(mediaBuffer).toString("base64")
  return {
    mediaType: "image",
    mimeType,
    filename: mediaResult.filename,
    imageDataUrl: `data:${mimeType};base64,${base64}`,
  }
}

export async function executeComfyWorkflow(
  baseUrl: string,
  workflow: Record<string, any>,
  signal: AbortSignal | undefined,
  opts: ComfyRunnerOptions,
): Promise<ComfyRunnerResult> {
  const gen = executeComfyWorkflowStream(baseUrl, workflow, signal, opts)
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

type WsEvent =
  | { type: "progress"; value: number; max: number }
  | { type: "executing"; nodeId: string }
  | { type: "preview"; imageBase64: string }
  | { type: "complete" }
  | { type: "error"; message: string }

async function* wsEventStream(
  ws: WebSocket,
  promptId: string,
  signal?: AbortSignal,
): AsyncGenerator<WsEvent, void, unknown> {
  const queue: WsEvent[] = []
  let resolve: (() => void) | null = null
  let done = false

  const enqueue = (event: WsEvent) => {
    queue.push(event)
    if (resolve) {
      resolve()
      resolve = null
    }
  }

  ws.addEventListener("message", (evt) => {
    if (typeof evt.data === "string") {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === "execution_cached" && msg.data?.prompt_id === promptId) {
          // tracking only, no event surfaced
        } else if (msg.type === "progress" && msg.data?.prompt_id === promptId) {
          enqueue({ type: "progress", value: msg.data.value, max: msg.data.max })
        } else if (msg.type === "executing" && msg.data?.prompt_id === promptId) {
          if (msg.data.node === null) {
            enqueue({ type: "complete" })
          } else {
            enqueue({ type: "executing", nodeId: String(msg.data.node) })
          }
        } else if (msg.type === "execution_error" && msg.data?.prompt_id === promptId) {
          enqueue({ type: "error", message: msg.data.exception_message || "Execution error" })
        }
      } catch {
        // malformed JSON — ignore
      }
    } else {
      // Binary preview frame. ComfyUI prefixes with an 8-byte header
      // describing the image format/encoding; we strip it and surface PNG.
      const buffer = Buffer.from(evt.data as ArrayBuffer)
      const imageData = buffer.subarray(8)
      const base64 = imageData.toString("base64")
      enqueue({ type: "preview", imageBase64: `data:image/png;base64,${base64}` })
    }
  })

  ws.addEventListener("close", () => {
    done = true
    if (resolve) {
      resolve()
      resolve = null
    }
  })

  signal?.addEventListener("abort", () => {
    done = true
    if (resolve) {
      resolve()
      resolve = null
    }
  })

  while (!done) {
    if (queue.length === 0) {
      await new Promise<void>((r) => { resolve = r })
    }
    while (queue.length > 0) {
      const event = queue.shift()!
      yield event
      if (event.type === "complete" || event.type === "error") {
        return
      }
    }
  }
}
