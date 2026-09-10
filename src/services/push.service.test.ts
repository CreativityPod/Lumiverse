import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { eventBus } from "../ws/bus";

const db = new Database(":memory:");
db.exec(await Bun.file(new URL("../db/migrations/035_push_subscriptions.sql", import.meta.url)).text());
mock.module("../db/connection", () => ({ getDb: () => db }));
mock.module("./settings.service", () => ({ getSetting: () => null }));
mock.module("../crypto/vapid", () => ({ getVapidPrivateJWK: () => ({}), getVapidPublicKey: () => "test-key" }));
mock.module("@pushforge/builder", () => ({
  buildPushHTTPRequest: async ({ subscription }: { subscription: { endpoint: string } }) => ({
    endpoint: subscription.endpoint, headers: {}, body: "encrypted-payload",
  }),
}));
const validateHost = mock(async (_hostname: string) => {});
mock.module("../utils/safe-fetch", () => ({ validateHost, SSRFError: class extends Error {} }));

const { createSubscription, dispatchGenerationEndedPush, sendPushToUser, listSubscriptions } = await import("./push.service");
const { pushRoutes } = await import("../routes/push.routes");
const userId = "push-test-user";
const originalFetch = globalThis.fetch;
const fetchMock = mock(async () => new Response(null, { status: 201 }));
globalThis.fetch = fetchMock as unknown as typeof fetch;

const app = new Hono();
app.use("*", async (c, next) => { c.set("userId", userId); await next(); });
app.route("/push", pushRoutes);

beforeEach(() => {
  db.exec("DELETE FROM push_subscriptions");
  fetchMock.mockClear();
  validateHost.mockReset();
  validateHost.mockImplementation(async () => {});
  for (const device of ["phone", "desktop"]) {
    eventBus.removeSessionVisibility(userId, device);
    createSubscription(userId, {
      endpoint: `https://push.example.com/${device}`, keys: { p256dh: "key", auth: "auth" },
    });
  }
});

afterAll(() => {
  for (const device of ["phone", "desktop"]) eventBus.removeSessionVisibility(userId, device);
  globalThis.fetch = originalFetch;
  db.close();
  mock.restore();
});

describe("push presence suppression", () => {
  test.each(["phone", "desktop"])("suppresses generation, extension, and test pushes while %s is visible", async (visibleDevice) => {
    eventBus.setUserVisibility(userId, "phone", visibleDevice === "phone");
    eventBus.setUserVisibility(userId, "desktop", visibleDevice === "desktop");

    expect(await dispatchGenerationEndedPush(userId, { content: "Done" })).toEqual({ sent: 0, reason: "user_active" });
    expect(await sendPushToUser(userId, { title: "Extension", body: "Done" })).toBe(0);
    const response = await app.request("/push/subscriptions/test", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: false, sent: 0, reason: "user_active" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listSubscriptions(userId)).toHaveLength(2);
  });

  test("delivers to both devices once all sessions are hidden", async () => {
    eventBus.setUserVisibility(userId, "phone", false);
    eventBus.setUserVisibility(userId, "desktop", false);
    expect(await dispatchGenerationEndedPush(userId, { content: "Done" })).toEqual({ sent: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("delivers when no app sessions are connected", async () => {
    expect(await dispatchGenerationEndedPush(userId, { content: "Done" })).toEqual({ sent: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("cancels delivery if the user returns during push preparation", async () => {
    const started = Promise.withResolvers<void>();
    const validated = Promise.withResolvers<void>();
    validateHost.mockImplementation(() => { started.resolve(); return validated.promise; });

    const pending = sendPushToUser(userId, { title: "Character", body: "Done" });
    await started.promise;
    eventBus.setUserVisibility(userId, "phone", true);
    validated.resolve();

    expect(await pending).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(listSubscriptions(userId)).toHaveLength(2);
  });
});
