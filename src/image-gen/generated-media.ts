import type { GeneratedMediaType, ImageGenResponse } from "./types";

export interface ResolvedGeneratedMedia {
  type: GeneratedMediaType;
  mimeType: string;
  filename: string;
  imageDataUrl?: string;
  data?: Uint8Array;
}

/** Prefer the MIME recorded by persistence over a stale provider discriminator. */
export function resolveStoredGeneratedMediaType(
  declaredType: GeneratedMediaType,
  storedMimeType: string,
): GeneratedMediaType {
  const mimeType = storedMimeType.trim().toLowerCase().split(";", 1)[0];
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  return declaredType;
}

function mimeTypeFromDataUrl(dataUrl: string): string | null {
  return dataUrl.match(/^data:([^;]+);base64,/)?.[1] ?? null;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "image/avif": return "avif";
    case "video/mp4": return "mp4";
    default: return "png";
  }
}

/** Normalize legacy image-only and new binary media provider responses. */
export function resolveGeneratedMedia(
  response: ImageGenResponse,
  fallbackStem: string,
): ResolvedGeneratedMedia | null {
  if (response.mediaType === "video") {
    if (!response.mediaData || response.mediaData.byteLength === 0) return null;
    const mimeType = response.mimeType || "video/mp4";
    return {
      type: "video",
      mimeType,
      // Persist under Lumiverse's generated-asset prefix. The public result
      // route intentionally rejects arbitrary uploaded filenames.
      filename: `${fallbackStem}.${extensionForMimeType(mimeType)}`,
      data: response.mediaData,
    };
  }

  if (!response.imageDataUrl) return null;
  const mimeType = response.mimeType || mimeTypeFromDataUrl(response.imageDataUrl) || "image/png";
  return {
    type: "image",
    mimeType,
    filename: `${fallbackStem}.${extensionForMimeType(mimeType)}`,
    imageDataUrl: response.imageDataUrl,
  };
}
