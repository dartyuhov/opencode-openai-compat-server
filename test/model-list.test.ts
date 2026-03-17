import { describe, expect, test } from "bun:test";

import { mapProviderCatalogToOpenAIModelList, type UpstreamProviderCatalog } from "../src/index.js";

describe("mapProviderCatalogToOpenAIModelList", () => {
  test("filters disconnected providers, skips empty providers, and emits stable model ids", () => {
    const catalog: UpstreamProviderCatalog = {
      fetchedAt: Date.now(),
      defaultModelsByProvider: {
        openai: "gpt-5.1",
      },
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          api: null,
          env: [],
          npm: null,
          connected: false,
          defaultModelId: null,
          models: [
            {
              id: "claude-sonnet-4",
              name: "Claude Sonnet 4",
              releaseDate: "2025-12-01",
              attachment: true,
              reasoning: true,
              temperature: true,
              toolCall: true,
              limit: {
                context: 200000,
                output: 8192,
              },
              cost: null,
              modalities: null,
              experimental: false,
              status: null,
              options: {},
              headers: {},
              providerPackageName: null,
            },
          ],
        },
        {
          id: "openai",
          name: "OpenAI",
          api: "chat",
          env: ["OPENAI_API_KEY"],
          npm: null,
          connected: true,
          defaultModelId: "gpt-5.1",
          models: [
            {
              id: "gpt-5.1-mini",
              name: "GPT 5.1 Mini",
              releaseDate: "2026-02-01",
              attachment: true,
              reasoning: true,
              temperature: true,
              toolCall: true,
              limit: {
                context: 200000,
                output: 8192,
              },
              cost: null,
              modalities: null,
              experimental: false,
              status: null,
              options: {},
              headers: {},
              providerPackageName: null,
            },
            {
              id: "gpt-5.1",
              name: "GPT 5.1",
              releaseDate: "2026-01-01",
              attachment: true,
              reasoning: true,
              temperature: true,
              toolCall: true,
              limit: {
                context: 200000,
                output: 16384,
              },
              cost: null,
              modalities: null,
              experimental: false,
              status: null,
              options: {},
              headers: {},
              providerPackageName: null,
            },
          ],
        },
        {
          id: "groq",
          name: "Groq",
          api: null,
          env: [],
          npm: null,
          connected: true,
          defaultModelId: null,
          models: [],
        },
      ],
    };

    expect(mapProviderCatalogToOpenAIModelList(catalog)).toEqual({
      object: "list",
      data: [
        {
          id: "openai/gpt-5.1",
          object: "model",
          created: 1767225600,
          owned_by: "openai",
        },
        {
          id: "openai/gpt-5.1-mini",
          object: "model",
          created: 1769904000,
          owned_by: "openai",
        },
      ],
    });
  });
});
