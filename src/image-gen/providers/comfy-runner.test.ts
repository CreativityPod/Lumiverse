import { describe, expect, test } from "bun:test";
import {
  buildComfyMediaViewUrl,
  findFirstComfyImageResult,
  findFirstComfyMediaResult,
} from "./comfy-runner";

describe("findFirstComfyMediaResult", () => {
  test("prefers a Video Helper Suite MP4 over a still preview", () => {
    const outputs = {
      "10": { images: [{ filename: "preview.png", subfolder: "", type: "temp" }] },
      "20": { gifs: [{ filename: "scene.mp4", subfolder: "clips", type: "output", format: "video/h264-mp4" }] },
    };

    expect(findFirstComfyMediaResult(outputs)).toEqual({
      mediaType: "video",
      filename: "scene.mp4",
      subfolder: "clips",
      type: "output",
    });
  });

  test("recognizes MP4 results exposed under videos or images", () => {
    expect(findFirstComfyMediaResult({ a: { videos: [{ filename: "a.mp4" }] } })?.mediaType).toBe("video");
    expect(findFirstComfyMediaResult({ a: { images: [{ filename: "a.mp4" }] } })?.mediaType).toBe("video");
  });

  test("falls back to the first ordinary image", () => {
    const result = findFirstComfyMediaResult({ a: { images: [{ filename: "final.webp" }] } });
    expect(result).toEqual({
      mediaType: "image",
      filename: "final.webp",
      subfolder: "",
      type: "output",
    });
    expect(findFirstComfyImageResult({ a: { images: [{ filename: "final.webp" }] } })).toEqual(result);
  });

  test("returns null when no supported output is present", () => {
    expect(findFirstComfyMediaResult({ a: { text: ["done"] } })).toBeNull();
  });
});

test("buildComfyMediaViewUrl encodes output fields", () => {
  expect(buildComfyMediaViewUrl("http://localhost:8188", {
    mediaType: "video",
    filename: "my scene.mp4",
    subfolder: "final clips",
    type: "output",
  })).toBe("http://localhost:8188/view?filename=my%20scene.mp4&subfolder=final%20clips&type=output");
});

