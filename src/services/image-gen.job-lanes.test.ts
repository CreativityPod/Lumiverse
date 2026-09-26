import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { resetActiveGenerationJobs } from "../image-gen/job-activity";
import { getImageProvider, registerImageProvider } from "../image-gen/registry";
import type { ImageProvider } from "../image-gen/provider";
import type { ImageGenRequest } from "../image-gen/types";
import { WorkerHostImageGenApi } from "../spindle/worker-host-image-gen-api";
import * as characters from "./characters.service";
import * as connections from "./image-gen-connections.service";
import { generateSceneBackground } from "./image-gen.service";
import * as settings from "./settings.service";

type PendingRequest = { request: ImageGenRequest; apiUrl: string; release: () => void };

let originalProvider: ImageProvider | undefined;
let pending: PendingRequest[];
let userId: string;

beforeAll(() => {
  originalProvider = getImageProvider("comfyui");
  registerImageProvider({
    name: "comfyui", displayName: "ComfyUI test",
    capabilities: { parameters: {}, apiKeyRequired: false, modelListStyle: "static", defaultUrl: "http://localhost:8188" },
    async generate(_key, apiUrl, request) {
      await new Promise<void>((release) => pending.push({ request, apiUrl, release }));
      return { imageDataUrl: "", model: request.model, provider: "comfyui" };
    },
    async validateKey() { return true; },
    async listModels() { return []; },
  });
});

afterAll(() => {
  if (originalProvider) registerImageProvider(originalProvider);
});

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  pending = [];
  userId = crypto.randomUUID();
  resetActiveGenerationJobs();
});

afterEach(() => {
  for (const entry of pending) entry.release();
  resetActiveGenerationJobs();
  closeDatabase();
});

async function comfyConnection(name: string, apiUrl: string, isDefault = false) {
  return connections.createConnection(userId, {
    name, provider: "comfyui", model: "workflow", is_default: isDefault, api_url: apiUrl,
  });
}

function createChat(): string {
  const character = characters.createCharacter(userId, { name: "Lane test" });
  const chatId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb().query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(chatId, userId, character.id, "Lane test", "{}", now, now);
  return chatId;
}

function useImgGenConnection(connectionId: string) {
  settings.putSetting(userId, "imageGeneration", {
    enabled: true, activeImageGenConnectionId: connectionId,
    promptMode: "custom", outputTarget: "preview", addToGallery: false,
  });
}

const customPrompt = { promptMode: "custom" as const, prompt: "a fox", skipParse: true, outputTarget: "preview" as const, forceGeneration: true };

async function waitForPending(count: number) {
  for (let i = 0; i < 200 && pending.length < count; i++) await Bun.sleep(5);
  expect(pending).toHaveLength(count);
}

function spindleApi(granted: (permission: string) => boolean = () => true) {
  const messages: any[] = [];
  const api = new WorkerHostImageGenApi({
    extensionIdentifier: "video_gen", hasPermission: granted as any,
    resolveEffectiveUserId: () => userId, enforceScopedUser: () => {},
    post: (message) => messages.push(message),
  });
  return { api, messages };
}

test("connectionId overrides the ImgGen panel's active connection", async () => {
  const image = await comfyConnection("Image", "http://image-box:8188", true);
  const video = await comfyConnection("Video", "http://video-box:8188");
  useImgGenConnection(image.id);
  const chatId = createChat();

  const run = generateSceneBackground(userId, chatId, { ...customPrompt, connectionId: video.id, jobNamespace: "video" });
  await waitForPending(1);
  expect(pending[0].apiUrl).toBe("http://video-box:8188");
  pending[0].release();
  await run;
});

test("a named lane is refused while ImgGen runs on the same ComfyUI server", async () => {
  const image = await comfyConnection("Image", "http://gpu:8188", true);
  const videoSameServer = await comfyConnection("Video", "http://GPU:8188/");
  const videoOtherServer = await comfyConnection("Video elsewhere", "http://other:8188");
  useImgGenConnection(image.id);
  const chatId = createChat();

  const imageRun = generateSceneBackground(userId, chatId, customPrompt);
  await waitForPending(1);

  await expect(generateSceneBackground(userId, chatId, {
    ...customPrompt, connectionId: videoSameServer.id, jobNamespace: "video",
  })).rejects.toThrow("IMAGE_GEN_BUSY:");

  const otherRun = generateSceneBackground(userId, chatId, {
    ...customPrompt, connectionId: videoOtherServer.id, jobNamespace: "video",
  });
  await waitForPending(2);

  for (const entry of pending) entry.release();
  await Promise.all([imageRun, otherRun]);
});

test("ImgGen does not supersede a named lane and queues ahead of it", async () => {
  const connection = await comfyConnection("Shared", "http://gpu:8188", true);
  useImgGenConnection(connection.id);
  const chatId = createChat();

  const videoRun = generateSceneBackground(userId, chatId, { ...customPrompt, connectionId: connection.id, jobNamespace: "video" });
  await waitForPending(1);
  expect(pending[0].request.queueFront).toBe(false);
  expect(pending[0].request.signal?.aborted).toBe(false);

  const imageRun = generateSceneBackground(userId, chatId, customPrompt);
  await waitForPending(2);
  expect(pending[1].request.queueFront).toBe(true);
  expect(pending[0].request.signal?.aborted).toBe(false);

  for (const entry of pending) entry.release();
  await Promise.all([videoRun, imageRun]);
});

test("spindle generateNative namespaces extension lanes and reports ImgGen activity", async () => {
  const image = await comfyConnection("Image", "http://gpu:8188", true);
  const video = await comfyConnection("Video", "http://gpu:8188");
  const elsewhere = await comfyConnection("Elsewhere", "http://other:8188");
  useImgGenConnection(image.id);
  const chatId = createChat();
  const { api, messages } = spindleApi();

  api.handleActivity("idle", undefined);
  expect(messages.at(-1)?.result).toEqual({ imageGenBusy: false, busyConnectionIds: [] });

  const imageRun = generateSceneBackground(userId, chatId, customPrompt);
  await waitForPending(1);

  api.handleActivity("busy", undefined);
  const activity = messages.at(-1)?.result;
  expect(activity.imageGenBusy).toBe(true);
  expect([...activity.busyConnectionIds].sort()).toEqual([image.id, video.id].sort());

  await api.handleGenerateNative("blocked", {
    chat_id: chatId, connection_id: video.id, job_namespace: "video", ...customPrompt,
  });
  expect(messages.at(-1)?.error).toContain("IMAGE_GEN_BUSY:");

  // Without a namespace the extension shares ImgGen's lane (legacy behavior),
  // so a named lane on another server must still run alongside ImgGen.
  const nativeRun = api.handleGenerateNative("other", {
    chat_id: chatId, connection_id: elsewhere.id, job_namespace: "video", ...customPrompt,
  });
  await waitForPending(2);
  expect(pending[0].request.signal?.aborted).toBe(false);

  for (const entry of pending) entry.release();
  await Promise.all([imageRun, nativeRun]);
  expect(messages.at(-1)?.error).toBeUndefined();
});

test("spindle generateNative chat output targets require chat_mutation", async () => {
  const connection = await comfyConnection("Video", "http://gpu:8188", true);
  useImgGenConnection(connection.id);
  const chatId = createChat();
  const { api, messages } = spindleApi((permission) => permission !== "chat_mutation");

  await api.handleGenerateNative("attach", { chat_id: chatId, ...customPrompt, outputTarget: "chat_attachment" });
  expect(messages.at(-1)?.error).toContain("chat_mutation");

  await api.handleGenerateNative("background", { chat_id: chatId, ...customPrompt, outputTarget: "background" });
  expect(messages.at(-1)?.error).toContain("Unsupported native outputTarget");

  await api.handleGenerateNative("missing", { chat_id: chatId, ...customPrompt, connection_id: "nope" });
  expect(messages.at(-1)?.error).toContain("connection not found");
  expect(pending).toHaveLength(0);
});
