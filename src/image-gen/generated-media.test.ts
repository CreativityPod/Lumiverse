import { describe, expect, test } from "bun:test";
import { resolveGeneratedMedia, resolveStoredGeneratedMediaType } from "./generated-media";

describe("resolveGeneratedMedia", () => {
  test("normalizes a legacy image-only provider response", () => {
    expect(resolveGeneratedMedia({
      imageDataUrl: "data:image/webp;base64,AA==",
      model: "model",
      provider: "provider",
    }, "fallback")).toEqual({
      type: "image",
      mimeType: "image/webp",
      filename: "fallback.webp",
      imageDataUrl: "data:image/webp;base64,AA==",
    });
  });

  test("keeps MP4 bytes out of a data URL", () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    expect(resolveGeneratedMedia({
      mediaType: "video",
      mediaData: bytes,
      mimeType: "video/mp4",
      filename: "scene.mp4",
      model: "workflow",
      provider: "comfyui",
    }, "fallback")).toEqual({
      type: "video",
      mimeType: "video/mp4",
      filename: "fallback.mp4",
      data: bytes,
    });
  });
});

describe("resolveStoredGeneratedMediaType", () => {
  test("repairs a stale image discriminator from the persisted MP4 MIME", () => {
    expect(resolveStoredGeneratedMediaType("image", "video/mp4")).toBe("video");
  });

  test("falls back to the provider discriminator for a generic MIME", () => {
    expect(resolveStoredGeneratedMediaType("video", "application/octet-stream")).toBe("video");
  });
});
