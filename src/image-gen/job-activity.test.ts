import { afterEach, expect, test } from "bun:test";
import {
  clearActiveGenerationJob,
  comfyServerKey,
  generationJobKey,
  hasNamespacedGenerationOn,
  isPrimaryGenerationBusyOn,
  normalizeJobNamespace,
  resetActiveGenerationJobs,
  setActiveGenerationJob,
} from "./job-activity";

afterEach(() => resetActiveGenerationJobs());

test("comfyServerKey groups profiles that share one ComfyUI host", () => {
  expect(comfyServerKey({ provider: "comfyui", api_url: "http://GPU-box:8188/" }))
    .toBe(comfyServerKey({ provider: "comfyui", api_url: "http://gpu-box:8188" }));
  expect(comfyServerKey({ provider: "comfyui", api_url: "" })).toBe("http://localhost:8188");
  expect(comfyServerKey({ provider: "swarmui", api_url: null })).toBe("http://localhost:7801");
  expect(comfyServerKey({ provider: "comfyui", api_url: "http://a:8188" }))
    .not.toBe(comfyServerKey({ provider: "comfyui", api_url: "http://b:8188" }));
  expect(comfyServerKey({ provider: "novelai", api_url: "https://image.novelai.net" })).toBeNull();
});

test("the primary lane keeps the historical registry key", () => {
  expect(generationJobKey("u", "c", null)).toBe("u:c");
  expect(generationJobKey("u", "c", "ext:video_gen:video")).toBe("u:c:ext:video_gen:video");
  expect(normalizeJobNamespace("  ")).toBeNull();
  expect(normalizeJobNamespace(" video ")).toBe("video");
});

test("busy checks distinguish lanes and ignore other servers and aborted jobs", () => {
  const server = "http://gpu:8188";
  const primary = new AbortController();
  setActiveGenerationJob("u:c", { controller: primary, startedAt: 0, namespace: null, serverKey: server });

  expect(isPrimaryGenerationBusyOn(server)).toBe(true);
  expect(isPrimaryGenerationBusyOn("http://other:8188")).toBe(false);
  expect(isPrimaryGenerationBusyOn(null)).toBe(false);
  expect(hasNamespacedGenerationOn(server)).toBe(false);

  const video = new AbortController();
  setActiveGenerationJob("u:c:video", { controller: video, startedAt: 0, namespace: "video", serverKey: server });
  expect(hasNamespacedGenerationOn(server)).toBe(true);

  primary.abort();
  expect(isPrimaryGenerationBusyOn(server)).toBe(false);
});

test("clearActiveGenerationJob only removes the owner's entry", () => {
  const server = "http://gpu:8188";
  const older = new AbortController();
  const newer = new AbortController();
  setActiveGenerationJob("u:c", { controller: older, startedAt: 0, namespace: null, serverKey: server });
  setActiveGenerationJob("u:c", { controller: newer, startedAt: 1, namespace: null, serverKey: server });

  clearActiveGenerationJob("u:c", older);
  expect(isPrimaryGenerationBusyOn(server)).toBe(true);
  clearActiveGenerationJob("u:c", newer);
  expect(isPrimaryGenerationBusyOn(server)).toBe(false);
});
