import type { UpstreamProviderCatalog } from "./upstream.js";

const ALLOWED_CHAT_COMPLETION_REQUEST_KEYS = new Set(["model", "messages", "stream"]);
const ALLOWED_CHAT_MESSAGE_KEYS = new Set(["role", "content"]);
const SUPPORTED_CHAT_MESSAGE_ROLES = ["system", "user", "assistant"] as const;

type JsonRecord = Record<string, unknown>;

export type OpenAIChatMessageRole = (typeof SUPPORTED_CHAT_MESSAGE_ROLES)[number];

export type OpenAIChatMessage = {
  role: OpenAIChatMessageRole;
  content: string;
};

export type OpenAIChatCompletionRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: false;
};

export type ResolvedChatCompletionModel = {
  model: string;
  providerId: string;
  modelId: string;
};

export type PreparedChatCompletionRequest = OpenAIChatCompletionRequest &
  ResolvedChatCompletionModel & {
    prompt: string;
  };

export class ChatCompletionValidationError extends Error {
  readonly param: string | null;
  readonly code: string | null;
  readonly failureReason: string;

  constructor(input: {
    message: string;
    param?: string | null;
    code?: string | null;
    failureReason: string;
  }) {
    super(input.message);
    this.name = "ChatCompletionValidationError";
    this.param = input.param ?? null;
    this.code = input.code ?? null;
    this.failureReason = input.failureReason;
  }
}

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const getUnsupportedKey = (value: JsonRecord, allowedKeys: Set<string>) =>
  Object.keys(value).find((key) => !allowedKeys.has(key)) ?? null;

const createValidationError = (input: {
  message: string;
  param?: string | null;
  code?: string | null;
  failureReason: string;
}) => new ChatCompletionValidationError(input);

const readRequiredString = (value: unknown, param: string) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createValidationError({
      message: `Invalid value for '${param}': expected a non-empty string.`,
      param,
      code: "invalid_string",
      failureReason: "invalid_string",
    });
  }

  return value.trim();
};

const parseMessageRole = (value: unknown, index: number): OpenAIChatMessageRole => {
  const param = `messages[${index}].role`;

  if (typeof value !== "string" || !SUPPORTED_CHAT_MESSAGE_ROLES.includes(value as OpenAIChatMessageRole)) {
    throw createValidationError({
      message: `Invalid value for '${param}': expected one of ${SUPPORTED_CHAT_MESSAGE_ROLES.map((role) => `'${role}'`).join(", ")}.`,
      param,
      code: "invalid_role",
      failureReason: "invalid_role",
    });
  }

  return value as OpenAIChatMessageRole;
};

const parseMessageContent = (value: unknown, index: number) => {
  const param = `messages[${index}].content`;

  if (Array.isArray(value)) {
    throw createValidationError({
      message: `Invalid value for '${param}': content arrays are not supported.`,
      param,
      code: "unsupported_content",
      failureReason: "unsupported_content",
    });
  }

  if (typeof value !== "string") {
    throw createValidationError({
      message: `Invalid value for '${param}': expected a string.`,
      param,
      code: "invalid_content",
      failureReason: "invalid_content",
    });
  }

  return value;
};

export const parseChatCompletionRequest = (value: unknown): OpenAIChatCompletionRequest => {
  if (!isRecord(value)) {
    throw createValidationError({
      message: "Request body must be a JSON object.",
      code: "invalid_request",
      failureReason: "invalid_request",
    });
  }

  const unsupportedKey = getUnsupportedKey(value, ALLOWED_CHAT_COMPLETION_REQUEST_KEYS);
  if (unsupportedKey) {
    throw createValidationError({
      message: `Unsupported field '${unsupportedKey}' in chat completion request.`,
      param: unsupportedKey,
      code: "unsupported_field",
      failureReason: "unsupported_field",
    });
  }

  const model = readRequiredString(value.model, "model");
  const stream = value.stream;

  if (stream !== undefined && stream !== false) {
    throw createValidationError({
      message: "Invalid value for 'stream': only false or omitted is supported.",
      param: "stream",
      code: "unsupported_stream",
      failureReason: "unsupported_stream",
    });
  }

  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw createValidationError({
      message: "Invalid value for 'messages': expected a non-empty array.",
      param: "messages",
      code: "invalid_messages",
      failureReason: "invalid_messages",
    });
  }

  const messages = value.messages.map((entry, index) => {
    if (!isRecord(entry)) {
      throw createValidationError({
        message: `Invalid value for 'messages[${index}]': expected an object.`,
        param: `messages[${index}]`,
        code: "invalid_message",
        failureReason: "invalid_message",
      });
    }

    const unsupportedMessageKey = getUnsupportedKey(entry, ALLOWED_CHAT_MESSAGE_KEYS);
    if (unsupportedMessageKey) {
      throw createValidationError({
        message: `Unsupported field 'messages[${index}].${unsupportedMessageKey}' in chat completion request.`,
        param: `messages[${index}].${unsupportedMessageKey}`,
        code: "unsupported_field",
        failureReason: "unsupported_field",
      });
    }

    return {
      role: parseMessageRole(entry.role, index),
      content: parseMessageContent(entry.content, index),
    };
  });

  return stream === false ? { model, messages, stream: false } : { model, messages };
};

export const resolveChatCompletionModel = (
  model: string,
  catalog: UpstreamProviderCatalog,
): ResolvedChatCompletionModel => {
  const modelParam = "model";
  const [providerId, modelId, ...extraSegments] = model.split("/");

  if (!providerId || !modelId || extraSegments.length > 0) {
    throw createValidationError({
      message: `Invalid value for '${modelParam}': expected the format 'provider/model'.`,
      param: modelParam,
      code: "invalid_model",
      failureReason: "invalid_model",
    });
  }

  const provider = catalog.providers.find((entry) => entry.connected && entry.id === providerId);
  const upstreamModel = provider?.models.find((entry) => entry.id === modelId);

  if (!provider || !upstreamModel) {
    throw createValidationError({
      message: `Invalid value for '${modelParam}': model '${model}' is not available from the current connected catalog.`,
      param: modelParam,
      code: "invalid_model",
      failureReason: "invalid_model",
    });
  }

  return {
    model,
    providerId,
    modelId,
  };
};

const getPromptLabel = (role: OpenAIChatMessageRole) => {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
  }
};

export const serializeChatCompletionMessages = (messages: OpenAIChatMessage[]) => {
  const sections: string[] = [];
  const systemMessages = messages.filter((message) => message.role === "system").map((message) => message.content);

  if (systemMessages.length > 0) {
    sections.push(`System:\n${systemMessages.join("\n\n")}`);
  }

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    sections.push(`${getPromptLabel(message.role)}:\n${message.content}`);
  }

  return sections.join("\n\n");
};

export const prepareChatCompletionRequest = (
  value: unknown,
  catalog: UpstreamProviderCatalog,
): PreparedChatCompletionRequest => {
  const request = parseChatCompletionRequest(value);
  const resolvedModel = resolveChatCompletionModel(request.model, catalog);

  return {
    ...request,
    ...resolvedModel,
    prompt: serializeChatCompletionMessages(request.messages),
  };
};
