import { afterEach, describe, expect, test } from "bun:test";
import { OpenVoxTtsProvider } from "./openvox-tts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenVoxTtsProvider", () => {
  test("uses the Lumiverse provider naming convention and local defaults", () => {
    const provider = new OpenVoxTtsProvider();

    expect(provider.name).toBe("openvox_tts");
    expect(provider.displayName).toBe("OpenVox TTS");
    expect(provider.capabilities.apiKeyRequired).toBe(false);
    expect(provider.capabilities.modelListStyle).toBe("dynamic");
    expect(provider.capabilities.voiceListStyle).toBe("dynamic");
    expect(provider.capabilities.defaultUrl).toBe("http://127.0.0.1:8000/v1");
  });

  test("lists every OpenVox model without the generic TTS name filter", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        data: [
          { id: "kokoro", name: "Kokoro-82M" },
          { id: "chatterbox-turbo-small", name: "Chatterbox Turbo Small" },
          { id: "qwen3-tts", name: "Qwen3 TTS" },
        ],
      }));
    };

    const models = await new OpenVoxTtsProvider().listModels("", "");

    expect(calls).toEqual(["http://127.0.0.1:8000/v1/models"]);
    expect(models).toEqual([
      { id: "chatterbox-turbo-small", label: "Chatterbox Turbo Small" },
      { id: "kokoro", label: "Kokoro-82M" },
      { id: "qwen3-tts", label: "Qwen3 TTS" },
    ]);
  });

  test("accepts the OpenVox models collection response shape", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      models: ["omnivoice", { model_id: "pocket-tts", display_name: "Pocket TTS" }],
    }));

    const models = await new OpenVoxTtsProvider().listModels("", "http://localhost:9000/v1/");

    expect(models).toEqual([
      { id: "omnivoice", label: "omnivoice" },
      { id: "pocket-tts", label: "Pocket TTS" },
    ]);
  });

  test("lists and normalizes voices for the selected model", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({
        voices: [
          { id: "af_bella", name: "Bella", language: "en", gender: "female" },
          { voice_id: "am_adam", display_name: "Adam", language_code: "en", gender: "male" },
        ],
      }));
    };

    const voices = await new OpenVoxTtsProvider().listVoices(
      "",
      "http://127.0.0.1:8000/v1/audio/speech",
      { model: "chatterbox/turbo" },
    );

    expect(calls).toEqual([
      "http://127.0.0.1:8000/v1/models/chatterbox%2Fturbo/voices",
    ]);
    expect(voices).toEqual([
      { id: "am_adam", name: "Adam", language: "en", gender: "male" },
      { id: "af_bella", name: "Bella", language: "en", gender: "female" },
    ]);
  });

  test("does not request voices until a model is selected", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}");
    };

    const voices = await new OpenVoxTtsProvider().listVoices("", "", {});

    expect(voices).toEqual([]);
    expect(calls).toBe(0);
  });

  test("adds the selected language to buffered speech requests", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/wav" },
      });
    };

    const result = await new OpenVoxTtsProvider().synthesize("", "", {
      text: "Hello",
      model: "kokoro",
      voice: "af_bella",
      parameters: { language: "fr", speed: 1.1 },
    });

    expect(body).toEqual({
      model: "kokoro",
      input: "Hello",
      voice: "af_bella",
      response_format: "wav",
      speed: 1.1,
      language: "fr",
    });
    expect(result.contentType).toBe("audio/wav");
  });
});
