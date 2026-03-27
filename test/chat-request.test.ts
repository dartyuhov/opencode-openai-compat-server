import { describe, expect, test } from "bun:test";

import {
  ChatCompletionValidationError,
  parseChatCompletionRequest,
  prepareChatCompletionRequest,
  serializeChatCompletionMessages,
  type UpstreamProviderCatalog,
} from "../src/index.js";

const catalog: UpstreamProviderCatalog = {
  fetchedAt: Date.now(),
  defaultModelsByProvider: {
    openai: "gpt-5.1",
  },
  providers: [
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
      id: "anthropic",
      name: "Anthropic",
      api: null,
      env: ["ANTHROPIC_API_KEY"],
      npm: null,
      connected: false,
      defaultModelId: "claude-sonnet-4",
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
  ],
};

const getValidationError = (callback: () => unknown) => {
  try {
    callback();
    throw new Error("Expected callback to throw.");
  } catch (error) {
    if (!(error instanceof ChatCompletionValidationError)) {
      throw error;
    }

    return error;
  }
};

describe("chat completion request helpers", () => {
  test("serializes system and transcript sections in a stable order", () => {
    expect(
      serializeChatCompletionMessages([
        {
          role: "system",
          content: "You are concise.",
        },
        {
          role: "user",
          content: "Say hello in one sentence.",
        },
        {
          role: "assistant",
          content: "Hello there.",
        },
        {
          role: "user",
          content: "Now say goodbye.",
        },
      ]),
    ).toBe(
      "System:\nYou are concise.\n\nUser:\nSay hello in one sentence.\n\nAssistant:\nHello there.\n\nUser:\nNow say goodbye.",
    );
  });

  test("prepares a validated request with resolved model ids and serialized prompt", () => {
    expect(
      prepareChatCompletionRequest(
        {
          model: "openai/gpt-5.1",
          stream: false,
          messages: [
            {
              role: "system",
              content: "You are concise.",
            },
            {
              role: "user",
              content: "Say hello in one sentence.",
            },
            {
              role: "assistant",
              content: "Hello there.",
            },
            {
              role: "user",
              content: "Now say goodbye.",
            },
          ],
        },
        catalog,
      ),
    ).toEqual({
      model: "openai/gpt-5.1",
      providerId: "openai",
      modelId: "gpt-5.1",
      stream: false,
      messages: [
        {
          role: "system",
          content: "You are concise.",
        },
        {
          role: "user",
          content: "Say hello in one sentence.",
        },
        {
          role: "assistant",
          content: "Hello there.",
        },
        {
          role: "user",
          content: "Now say goodbye.",
        },
      ],
      prompt:
        "System:\nYou are concise.\n\nUser:\nSay hello in one sentence.\n\nAssistant:\nHello there.\n\nUser:\nNow say goodbye.",
    });
  });

  test("prepares a validated request when a bare model id uniquely matches one connected provider", () => {
    expect(
      prepareChatCompletionRequest(
        {
          model: "gpt-5.1",
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        },
        catalog,
      ),
    ).toEqual({
      model: "gpt-5.1",
      providerId: "openai",
      modelId: "gpt-5.1",
      messages: [
        {
          role: "user",
          content: "Hello",
        },
      ],
      prompt: "User:\nHello",
    });
  });

  test("accepts optional temperature for client compatibility", () => {
    expect(
      parseChatCompletionRequest({
        model: "openai/gpt-5.1",
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
        temperature: 0.2,
      }),
    ).toEqual({
      model: "openai/gpt-5.1",
      messages: [
        {
          role: "user",
          content: "Hello",
        },
      ],
      temperature: 0.2,
    });
  });

  test("accepts stream=true for streaming clients", () => {
    expect(
      parseChatCompletionRequest({
        model: "openai/gpt-5.1",
        stream: true,
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
      }),
    ).toEqual({
      model: "openai/gpt-5.1",
      stream: true,
      messages: [
        {
          role: "user",
          content: "Hello",
        },
      ],
    });
  });

  test("rejects unsupported top-level fields with a field-specific error", () => {
    const error = getValidationError(() =>
      parseChatCompletionRequest({
        model: "openai/gpt-5.1",
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
        top_p: 0.9,
      }),
    );

    expect(error).toMatchObject({
      message: "Unsupported field 'top_p' in chat completion request.",
      param: "top_p",
      code: "unsupported_field",
      failureReason: "unsupported_field",
    });
  });

  test("rejects non-numeric temperature values", () => {
    const error = getValidationError(() =>
      parseChatCompletionRequest({
        model: "openai/gpt-5.1",
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
        temperature: "0.2",
      }),
    );

    expect(error).toMatchObject({
      message: "Invalid value for 'temperature': expected a finite number.",
      param: "temperature",
      code: "invalid_temperature",
      failureReason: "invalid_temperature",
    });
  });

  test("rejects invalid stream values and empty message arrays", () => {
    const streamError = getValidationError(() =>
      parseChatCompletionRequest({
        model: "openai/gpt-5.1",
        messages: [
          {
            role: "user",
            content: "Hello",
          },
        ],
        stream: "yes",
      }),
    );
    const messagesError = getValidationError(() =>
      parseChatCompletionRequest({
        model: "openai/gpt-5.1",
        messages: [],
      }),
    );

    expect(streamError).toMatchObject({
      message: "Invalid value for 'stream': expected a boolean.",
      param: "stream",
      code: "invalid_stream",
      failureReason: "invalid_stream",
    });
    expect(messagesError).toMatchObject({
      message: "Invalid value for 'messages': expected a non-empty array.",
      param: "messages",
      code: "invalid_messages",
      failureReason: "invalid_messages",
    });
  });

  test("rejects multimodal content arrays, unknown models, and ambiguous bare models", () => {
    const ambiguousCatalog: UpstreamProviderCatalog = {
      ...catalog,
      providers: [
        catalog.providers[0]!,
        {
          ...catalog.providers[0]!,
          id: "openrouter",
          name: "OpenRouter",
        },
      ],
    };
    const multimodalError = getValidationError(() =>
      parseChatCompletionRequest({
        model: "openai/gpt-5.1",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Hello",
              },
            ],
          },
        ],
      }),
    );
    const unknownModelError = getValidationError(() =>
      prepareChatCompletionRequest(
        {
          model: "anthropic/claude-sonnet-4",
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        },
        catalog,
      ),
    );
    const ambiguousModelError = getValidationError(() =>
      prepareChatCompletionRequest(
        {
          model: "gpt-5.1",
          messages: [
            {
              role: "user",
              content: "Hello",
            },
          ],
        },
        ambiguousCatalog,
      ),
    );

    expect(multimodalError).toMatchObject({
      message: "Invalid value for 'messages[0].content': content arrays are not supported.",
      param: "messages[0].content",
      code: "unsupported_content",
      failureReason: "unsupported_content",
    });
    expect(unknownModelError).toMatchObject({
      message:
        "Invalid value for 'model': model 'anthropic/claude-sonnet-4' is not available from the current connected catalog.",
      param: "model",
      code: "invalid_model",
      failureReason: "invalid_model",
    });
    expect(ambiguousModelError).toMatchObject({
      message:
        "Invalid value for 'model': bare model 'gpt-5.1' is ambiguous across the current connected catalog; use the format 'provider/model'.",
      param: "model",
      code: "invalid_model",
      failureReason: "invalid_model",
    });
  });
});
