# Image and Video Generation

!!! warning "Permission required: `image_gen`"

Generate media programmatically via the user's configured image-gen connection profiles. Most providers return images; ComfyUI and Comfy-backed SwarmUI workflows may return a final MP4 video. The API name and `image_gen` permission remain unchanged for backward compatibility.

## `spindle.imageGen.generate(input)`

Generate a result using a connection profile. If `connection_id` is omitted, the user's default image-gen connection is used.

```ts
const result = await spindle.imageGen.generate({
  prompt: 'A serene mountain landscape at sunset, anime style',
  connection_id: 'optional-connection-id',
})
// result: {
//   mediaType: "image",
//   mediaId: "img-...",
//   mediaUrl: "/api/v1/image-gen/results/img-...",
//   mimeType: "image/png",
//   imageDataUrl: "data:image/png;base64,...", // legacy image field
//   imageId: "img-...",                       // legacy image field
//   imageUrl: "/api/v1/image-gen/results/img-...",
//   model: "...",
//   provider: "..."
// }
```

When the extension only needs the persisted image (`imageId` / `imageUrl`) or generic media reference (`mediaId` / `mediaUrl`), pass
`includeDataUrl: false` to omit the base64 `imageDataUrl` from the result. The
host still persists the result but
skips shipping the largest per-image RPC payload back to the worker:

```ts
const result = await spindle.imageGen.generate({
  prompt: 'A serene mountain landscape at sunset, anime style',
  connection_id: 'optional-connection-id',
  includeDataUrl: false,
})
// result: { mediaType: "image", mediaId: "img-...", mediaUrl: "/api/v1/image-gen/results/img-...", imageId: "img-...", imageUrl: "/api/v1/image-gen/results/img-...", model: "...", provider: "..." }
```

The default (`includeDataUrl` omitted or `true`) keeps the data URL for
backward compatibility. MP4 results are always persisted and returned by URL;
video bytes are never expanded into an extension-facing data URL.

For a ComfyUI workflow whose final output is MP4 (including Video Helper Suite
outputs reported under `gifs`), the result is shaped like this:

```ts
{
  mediaType: 'video',
  mediaId: 'asset-id',
  mediaUrl: '/api/v1/image-gen/results/asset-id',
  mimeType: 'video/mp4',
  posterUrl: '/api/v1/image-gen/results/asset-id?size=lg',
  model: 'comfyui-workflow',
  provider: 'comfyui',
}
```


You can override the model and pass provider-specific parameters:

```ts
const result = await spindle.imageGen.generate({
  prompt: '1girl, fantasy armor, detailed background',
  connection_id: 'my-novelai-connection',
  model: 'nai-diffusion-4-5-full',
  parameters: {
    resolution: '1024x1024',
    steps: 35,
    guidance: 7,
    sampler: 'k_euler_ancestral',
  },
})
```

For full control, use `rawRequestOverride` to deep-merge arbitrary JSON into the provider's request body:

```ts
const result = await spindle.imageGen.generate({
  prompt: 'A futuristic cityscape',
  parameters: {
    rawRequestOverride: JSON.stringify({
      generationConfig: {
        imageGenerationConfig: { aspectRatio: '21:9' },
      },
    }),
  },
})
```

## `spindle.imageGen.generateStream(input)`

Generate media while receiving live WebSocket status updates and image preview frames. This API is available only for connection providers that advertise `websocketPreviewStreaming`; currently, that includes **SwarmUI** and **ComfyUI**. A video workflow still emits image preview frames, then returns the persisted MP4 in its terminal `done` event.

Unlike [`generate()`](#spindleimagegengenerateinput), this returns an async iterator. It yields a terminal `done` event rather than returning the final media result directly.

```ts
let latestPreview: string | undefined

const stream = spindle.imageGen.generateStream({
  connection_id: 'my-swarmui-connection',
  prompt: 'An art-deco observatory under a meteor shower',
  parameters: { steps: 30 },
})

for await (const event of stream) {
  switch (event.type) {
    case 'status':
      // SwarmUI reports percentage-derived progress; ComfyUI may report
      // execution nodes instead of numerical steps.
      spindle.log.info(
        `Progress: ${event.step ?? '?'} / ${event.totalSteps ?? '?'} ` +
        `(node: ${event.nodeId ?? 'n/a'})`,
      )
      break

    case 'preview':
      // A data URL such as data:image/png;base64,...
      // Forward it to your frontend or replace the previous preview in memory.
      latestPreview = event.imageDataUrl
      spindle.sendToFrontend({ type: 'image-preview', imageDataUrl: latestPreview })
      break

    case 'done':
      // Same shape as the result from spindle.imageGen.generate().
      spindle.log.info(`Saved generated media: ${event.result.mediaId ?? 'not persisted'}`)
      break
  }
}
```

For an operator-scoped extension, pass the relevant `userId` as the second argument to `sendToFrontend()` so preview frames are not broadcast to every connected user. See [Backend-to-Frontend Communication](frontend-communication.md) for the scoping rules.

`preview` events also include `step`, `totalSteps`, and `nodeId` when those values were supplied with the frame. When a provider sends a preview and status in the same update, the iterator yields a `status` event followed by its `preview` event.

### Choosing the streamed or regular API

Inspect the connection's provider before starting a job. If it does not support preview streaming, use `generate()` as the fallback rather than attempting to create a stream.

```ts
const connection = await spindle.imageGen.getConnection('image-connection-id')
if (!connection) throw new Error('Image connection not found')

const providers = await spindle.imageGen.getProviders()
const provider = providers.find((item) => item.id === connection.provider)

if (provider?.capabilities.websocketPreviewStreaming) {
  for await (const event of spindle.imageGen.generateStream({
    connection_id: connection.id,
    prompt: 'A soft watercolor map of a floating city',
  })) {
    if (event.type === 'preview') {
      spindle.sendToFrontend({ type: 'image-preview', imageDataUrl: event.imageDataUrl })
    }
  }
} else {
  const result = await spindle.imageGen.generate({
    connection_id: connection.id,
    prompt: 'A soft watercolor map of a floating city',
  })
  spindle.sendToFrontend({ type: 'image-complete', imageDataUrl: result.imageDataUrl })
}
```

### Cancelling a stream

Pass an `AbortSignal` to cancel the upstream generation, including the provider WebSocket. Breaking out of a `for await` loop also requests cancellation automatically.

```ts
const controller = new AbortController()
const stream = spindle.imageGen.generateStream({
  prompt: 'A neon-lit forest path',
  signal: controller.signal,
})

setTimeout(() => controller.abort(), 10_000)

try {
  for await (const event of stream) {
    if (event.type === 'preview') {
      spindle.sendToFrontend({ type: 'image-preview', imageDataUrl: event.imageDataUrl })
    }
  }
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    spindle.log.info('Media generation cancelled')
  } else {
    throw err
  }
}
```

!!! tip "Keep preview handling lightweight"

    Preview frames are base64 data URLs and can be large. Keep only the latest frame, forward it promptly to the frontend, and do not persist every intermediate frame to extension storage.

### Stream event types

| Event | Fields | Meaning |
|---|---|---|
| `status` | `step?`, `totalSteps?`, `nodeId?` | A provider progress or workflow-node update. Some providers omit numerical progress. |
| `preview` | `imageDataUrl`, `step?`, `totalSteps?`, `nodeId?` | A preview image data URL, with status metadata when available. |
| `done` | `result: ImageGenResultDTO` | The completed, persisted image or video result. |

`generateStream()` requires the same `image_gen` permission and accepts all fields from `ImageGenRequestDTO`, plus an optional `signal: AbortSignal`.

### ImageGenRequestDTO

| Field | Type | Description |
|---|---|---|
| `prompt` | `string` | **Required.** Text prompt for image generation. |
| `connection_id` | `string` | Optional. Use a specific image gen connection profile. If omitted, uses the user's default. |
| `model` | `string` | Optional. Override the connection profile's model. |
| `negativePrompt` | `string` | Optional. Negative prompt (provider-dependent). |
| `parameters` | `Record<string, unknown>` | Optional. Provider-specific parameters, merged with the connection's `default_parameters`. |
| `owner_character_id` | `string` | Optional. Tag the persisted generated media to a specific character. |
| `owner_chat_id` | `string` | Optional. Tag the persisted generated media to a specific chat. |
| `userId` | `string` | **Required for operator-scoped extensions.** |

### ImageGenResultDTO (media-capable)

| Field | Type | Description |
|---|---|---|
| `mediaType` | `'image' \| 'video'` | Type of the final persisted result. |
| `mediaId` | `string` | Persisted asset ID in the shared image/video table. |
| `mediaUrl` | `string` | Public URL for the generated media. MP4 responses support byte ranges. |
| `mimeType` | `string` | Stored content type, such as `image/png` or `video/mp4`. |
| `posterUrl` | `string` | Optional generated-video poster URL. |
| `imageDataUrl` | `string?` | Image-only legacy field. Base64-encoded generated image; absent for video. |
| `model` | `string` | The model that was used. |
| `provider` | `string` | Identifier of the provider that produced the result, such as `comfyui`, `swarmui`, `google_gemini`, `nanogpt`, or `novelai`. |
| `imageId` | `string` | Image-only compatibility alias for `mediaId`. |
| `imageUrl` | `string` | Image-only compatibility alias for `mediaUrl`. |

### Media Persistence

Generated images and videos are automatically saved to the shared images table with thumbnail or poster support. The persisted row is automatically tagged to the current extension, and you can additionally pass `owner_character_id` and/or `owner_chat_id` to make later retrieval via `spindle.images.list()` and `spindle.images.get()` much cheaper and more targeted.

Use `mediaId` / `mediaUrl` for either result type. The legacy `imageId` / `imageUrl` aliases remain available for image results and existing integrations.

```ts
const result = await spindle.imageGen.generate({
  prompt: 'Character portrait for the current scene',
  owner_character_id: 'char-id',
  owner_chat_id: 'chat-id',
})

const relatedImages = await spindle.images.list({
  onlyOwned: true,
  characterId: 'char-id',
  specificity: 'sm',
})
```

### Push Notification Integration

The `imageUrl` is designed to work with push notifications. Since push payloads can't carry inline images, use the URL in the `image` field:

```ts
const result = await spindle.imageGen.generate({
  prompt: 'A cozy campfire scene at night',
})

if (result.imageUrl) {
  await spindle.push.send({
    title: 'Scene Generated',
    body: 'A new background image is ready',
    image: result.imageUrl,
  })
}
```

The `?size=sm` or `?size=lg` query parameter can be appended to get thumbnails:

```ts
const thumbUrl = `${result.imageUrl}?size=sm`  // ~300px thumbnail
```

---

## `spindle.imageGen.getProviders(userId?)`

List available image generation providers with their capability schemas. The schemas describe each provider's supported parameters, models, and features — useful for building dynamic settings UIs.

```ts
const providers = await spindle.imageGen.getProviders()

for (const provider of providers) {
  spindle.log.info(`${provider.name} (${provider.id})`)
  spindle.log.info(`  Models: ${provider.capabilities.staticModels?.map(m => m.label).join(', ')}`)
  spindle.log.info(`  Parameters: ${Object.keys(provider.capabilities.parameters).join(', ')}`)
}
```

### ImageGenProviderDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Provider identifier (`google_gemini`, `nanogpt`, `novelai`). |
| `name` | `string` | Display name. |
| `capabilities` | `object` | Provider capabilities (see below). |

### Capabilities

| Field | Type | Description |
|---|---|---|
| `parameters` | `Record<string, ImageGenParameterSchemaDTO>` | Supported parameters with types, defaults, min/max, options. |
| `apiKeyRequired` | `boolean` | Whether an API key is required. |
| `modelListStyle` | `"static" \| "dynamic" \| "google"` | How models are listed: baked-in, live API fetch, or Google model filtering. |
| `staticModels` | `Array<{ id, label }>` | Baked-in model list (always present for `static` providers). |
| `defaultUrl` | `string` | Default API endpoint. |
| `websocketPreviewStreaming` | `{ previews: true, status: true }` | Present when `generateStream()` can receive WebSocket previews and status from this provider. |

### ImageGenParameterSchemaDTO

| Field | Type | Description |
|---|---|---|
| `type` | `string` | `"number"`, `"integer"`, `"boolean"`, `"string"`, `"select"`, `"image_array"`. |
| `default` | `unknown` | Default value. |
| `min`, `max`, `step` | `number` | Range constraints (for numeric types). |
| `description` | `string` | Human-readable description. |
| `options` | `Array<{ id, label }>` | Fixed options (for `select` type). |
| `group` | `string` | UI grouping hint (`"advanced"`, `"references"`). |

---

## `spindle.imageGen.listConnections(userId?)`

List the user's image gen connection profiles. API keys are never exposed — only the `has_api_key` boolean.

```ts
const connections = await spindle.imageGen.listConnections()

for (const conn of connections) {
  spindle.log.info(`${conn.name} (${conn.provider}) — model: ${conn.model}`)
}
```

### ImageGenConnectionDTO

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Connection profile ID. |
| `name` | `string` | Display name. |
| `provider` | `string` | Provider identifier. |
| `api_url` | `string` | Custom API endpoint (empty = provider default). |
| `model` | `string` | Selected model. |
| `is_default` | `boolean` | Whether this is the user's default image gen connection. |
| `has_api_key` | `boolean` | Whether an API key is configured (value never exposed). |
| `default_parameters` | `Record<string, unknown>` | Provider-specific default parameters. |
| `metadata` | `Record<string, unknown>` | Arbitrary metadata. |
| `created_at` | `number` | Unix epoch seconds. |
| `updated_at` | `number` | Unix epoch seconds. |

---

## `spindle.imageGen.getConnection(connectionId, userId?)`

Get a single image gen connection profile by ID. Returns `null` if not found.

```ts
const conn = await spindle.imageGen.getConnection('connection-id')
if (conn) {
  spindle.log.info(`Using ${conn.name} with model ${conn.model}`)
}
```

---

## `spindle.imageGen.getModels(connectionId, userId?)`

List available models for a specific connection profile. For providers with dynamic model lists (e.g. NanoGPT), this fetches live from the upstream API.

```ts
const models = await spindle.imageGen.getModels('connection-id')

for (const model of models) {
  spindle.log.info(`${model.id}: ${model.label}`)
}
```

Returns `Array<{ id: string; label: string }>`.
