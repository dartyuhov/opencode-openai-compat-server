import { describe, expect, test } from "bun:test";

import {
  ChatCompletionValidationError,
  UpstreamClientError,
  mapAssistantMessageToChatCompletion,
  mapErrorToOpenAIResponse,
  type UpstreamAssistantMessage,
} from "../src/index.js";

const buildAssistantMessage = (
  overrides: Partial<UpstreamAssistantMessage> = {},
): UpstreamAssistantMessage => ({
  id: "message-1",
  sessionId: "session-123",
  parentId: "message-0",
  providerId: "openai",
  modelId: "gpt-5.1",
  role: "assistant",
  mode: "chat",
  path: {
    cwd: "/workspace/demo",
    root: "/workspace/demo",
  },
  finish: "stop",
  createdAt: 1_700_000_002_123,
  completedAt: 1_700_000_003_456,
  cost: 0.42,
  tokens: {
    input: 12,
    output: 7,
    reasoning: 2,
    cache: {
      read: 1,
      write: 0,
    },
  },
  text: "Hello world",
  parts: [
    {
      id: "part-1",
      type: "reasoning",
      raw: {
        type: "reasoning",
        text: "hidden reasoning",
      },
    },
    {
      id: "part-2",
      type: "text",
      text: "Hello",
      ignored: false,
      synthetic: false,
    },
    {
      id: "part-3",
      type: "text",
      text: " ignored",
      ignored: true,
      synthetic: false,
    },
    {
      id: "part-4",
      type: "text",
      text: " world",
      ignored: false,
      synthetic: false,
    },
  ],
  ...overrides,
});

const getThrownError = (callback: () => unknown) => {
  try {
    callback();
    throw new Error("Expected callback to throw.");
  } catch (error) {
    return error;
  }
};

describe("sidecar response mapping helpers", () => {
  test("maps assistant text parts into an OpenAI chat completion payload", () => {
    expect(mapAssistantMessageToChatCompletion(buildAssistantMessage(), "openai/gpt-5.1")).toEqual({
      id: "message-1",
      object: "chat.completion",
      created: 1_700_000_002,
      model: "openai/gpt-5.1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello world",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 7,
        total_tokens: 19,
      },
    });
  });

  test("fails closed when the upstream assistant message contains no usable text parts", () => {
    expect(
      getThrownError(() =>
        mapAssistantMessageToChatCompletion(
          buildAssistantMessage({
            parts: [
              {
                id: "part-1",
                type: "reasoning",
                raw: {
                  type: "reasoning",
                  text: "hidden reasoning",
                },
              },
            ],
            tokens: {
              input: 8,
              output: 0,
              reasoning: 1,
              cache: {
                read: 0,
                write: 0,
              },
            },
          }),
          "openai/gpt-5.1",
        ),
      ),
    ).toMatchObject({
      name: "UpstreamClientError",
      code: "invalid_response",
      message: "OpenCode upstream returned an invalid response.",
      endpoint: "/session/session-123/message",
    });
  });

  test("maps validation, upstream, and unexpected errors into OpenAI envelopes", async () => {
    const validation = mapErrorToOpenAIResponse(
      new ChatCompletionValidationError({
        message: "Invalid value for 'model'.",
        param: "model",
        code: "invalid_model",
        failureReason: "invalid_model",
      }),
    );
    const upstream = mapErrorToOpenAIResponse(
      new UpstreamClientError({
        code: "timeout",
        message: "OpenCode upstream request timed out.",
        endpoint: "/provider",
        retryable: true,
      }),
    );
    const unexpected = mapErrorToOpenAIResponse(new Error("boom"));

    expect(validation.failureReason).toBe("invalid_model");
    expect(await validation.response.json()).toEqual({
      error: {
        message: "Invalid value for 'model'.",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_model",
      },
    });

    expect(upstream.failureReason).toBe("timeout");
    expect(await upstream.response.json()).toEqual({
      error: {
        message: "OpenCode upstream request timed out.",
        type: "api_error",
        param: null,
        code: "timeout",
      },
    });

    expect(unexpected.failureReason).toBe("internal_error");
    expect(await unexpected.response.json()).toEqual({
      error: {
        message: "The OpenAI compatibility sidecar encountered an unexpected error.",
        type: "server_error",
        param: null,
        code: "internal_error",
      },
    });
  });
});
