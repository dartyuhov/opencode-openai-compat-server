const ALLOWED_MODALITIES = ["text", "audio", "image", "video", "pdf"] as const;
const ALLOWED_MODEL_STATUSES = ["alpha", "beta", "deprecated", "active"] as const;

type JsonRecord = Record<string, unknown>;

type CachedProviderCatalog = {
  catalog: UpstreamProviderCatalog;
  expiresAt: number;
};

export type UpstreamModality = (typeof ALLOWED_MODALITIES)[number];
export type UpstreamModelStatus = (typeof ALLOWED_MODEL_STATUSES)[number];

export type UpstreamClientErrorCode =
  | "auth"
  | "bad_request"
  | "invalid_response"
  | "network"
  | "not_found"
  | "timeout"
  | "upstream";

export type OpenCodeUpstreamClientOptions = {
  baseUrl: string | URL;
  username?: string | null;
  password?: string | null;
  requestTimeoutMs: number;
  modelsCacheTtlMs: number;
  directory?: string | null;
  fetch?: typeof fetch;
};

export type UpstreamProviderCatalogRequest = {
  directory?: string | null;
  forceRefresh?: boolean;
};

export type CreateUpstreamSessionInput = {
  directory?: string | null;
  parentSessionId?: string | null;
  title?: string | null;
};

export type CreateUpstreamAssistantMessageInput = {
  sessionId: string;
  directory?: string | null;
  providerId: string;
  modelId: string;
  agent?: string | null;
  prompt: string;
  system?: string | null;
};

export type UpstreamModelCost = {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  contextOver200k: UpstreamModelCost | null;
};

export type UpstreamModel = {
  id: string;
  name: string;
  releaseDate: string;
  attachment: boolean;
  reasoning: boolean;
  temperature: boolean;
  toolCall: boolean;
  limit: {
    context: number;
    output: number;
  };
  cost: UpstreamModelCost | null;
  modalities: {
    input: UpstreamModality[];
    output: UpstreamModality[];
  } | null;
  experimental: boolean;
  status: UpstreamModelStatus | null;
  options: JsonRecord;
  headers: Record<string, string>;
  providerPackageName: string | null;
};

export type UpstreamProvider = {
  id: string;
  name: string;
  api: string | null;
  env: string[];
  npm: string | null;
  connected: boolean;
  defaultModelId: string | null;
  models: UpstreamModel[];
};

export type UpstreamProviderCatalog = {
  fetchedAt: number;
  defaultModelsByProvider: Record<string, string>;
  providers: UpstreamProvider[];
};

export type UpstreamSession = {
  id: string;
  projectId: string;
  directory: string;
  parentId: string | null;
  title: string;
  version: string;
  shareUrl: string | null;
  createdAt: number;
  updatedAt: number;
  compactingAt: number | null;
};

export type UpstreamAssistantMessagePart =
  | {
      id: string;
      type: "text";
      text: string;
      ignored: boolean;
      synthetic: boolean;
    }
  | {
      id: string;
      type: string;
      raw: JsonRecord;
    };

export type UpstreamAssistantMessage = {
  id: string;
  sessionId: string;
  parentId: string;
  providerId: string;
  modelId: string;
  role: "assistant";
  mode: string;
  path: {
    cwd: string;
    root: string;
  };
  finish: string | null;
  createdAt: number;
  completedAt: number | null;
  cost: number | null;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  } | null;
  text: string;
  parts: UpstreamAssistantMessagePart[];
};

export class UpstreamClientError extends Error {
  readonly code: UpstreamClientErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly endpoint: string;
  readonly sourceStatus: number | null;
  readonly upstreamErrorName: string | null;

  constructor(input: {
    code: UpstreamClientErrorCode;
    message: string;
    status?: number;
    retryable?: boolean;
    endpoint: string;
    sourceStatus?: number | null;
    upstreamErrorName?: string | null;
  }) {
    super(input.message);
    this.name = "UpstreamClientError";
    this.code = input.code;
    this.status = input.status ?? 502;
    this.retryable = input.retryable ?? false;
    this.endpoint = input.endpoint;
    this.sourceStatus = input.sourceStatus ?? null;
    this.upstreamErrorName = input.upstreamErrorName ?? null;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      endpoint: this.endpoint,
      sourceStatus: this.sourceStatus,
      upstreamErrorName: this.upstreamErrorName,
    };
  }
}

export const isUpstreamClientError = (value: unknown): value is UpstreamClientError => value instanceof UpstreamClientError;

export class OpenCodeUpstreamClient {
  readonly requestTimeoutMs: number;
  readonly modelsCacheTtlMs: number;

  private readonly baseUrl: URL;
  private readonly defaultDirectory: string | null;
  private readonly basicAuthHeader: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly providerCache = new Map<string, CachedProviderCatalog>();
  private readonly inflightProviderRequests = new Map<string, Promise<UpstreamProviderCatalog>>();

  constructor(options: OpenCodeUpstreamClientOptions) {
    if (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) {
      throw new RangeError("requestTimeoutMs must be a positive number.");
    }

    if (!Number.isFinite(options.modelsCacheTtlMs) || options.modelsCacheTtlMs <= 0) {
      throw new RangeError("modelsCacheTtlMs must be a positive number.");
    }

    const parsedBaseUrl = new URL(options.baseUrl);
    const embeddedUsername = normalizeOptionalString(parsedBaseUrl.username);
    const embeddedPassword = normalizeOptionalString(parsedBaseUrl.password);

    parsedBaseUrl.username = "";
    parsedBaseUrl.password = "";
    parsedBaseUrl.search = "";
    parsedBaseUrl.hash = "";

    if (!parsedBaseUrl.pathname.endsWith("/")) {
      parsedBaseUrl.pathname = `${parsedBaseUrl.pathname}/`;
    }

    this.baseUrl = parsedBaseUrl;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.modelsCacheTtlMs = options.modelsCacheTtlMs;
    this.defaultDirectory = normalizeOptionalString(options.directory);
    this.fetchImpl = options.fetch ?? fetch;
    this.basicAuthHeader = createBasicAuthHeader(
      normalizeOptionalString(options.username) ?? embeddedUsername,
      normalizeOptionalString(options.password) ?? embeddedPassword,
    );
  }

  clearProviderCache() {
    this.providerCache.clear();
    this.inflightProviderRequests.clear();
  }

  async getProviderCatalog(options: UpstreamProviderCatalogRequest = {}) {
    const directory = this.resolveDirectory(options.directory);
    const cacheKey = directory ?? "";
    const now = Date.now();
    const cached = this.providerCache.get(cacheKey);

    if (!options.forceRefresh && cached && cached.expiresAt > now) {
      return cached.catalog;
    }

    const inflightRequest = this.inflightProviderRequests.get(cacheKey);
    if (inflightRequest) {
      return inflightRequest;
    }

    const request = this.requestJson({
      method: "GET",
      path: "/provider",
      directory,
      parse: (value) => {
        const fetchedAt = Date.now();
        return parseProviderCatalog(value, fetchedAt);
      },
    })
      .then((catalog) => {
        this.providerCache.set(cacheKey, {
          catalog,
          expiresAt: catalog.fetchedAt + this.modelsCacheTtlMs,
        });
        return catalog;
      })
      .finally(() => {
        this.inflightProviderRequests.delete(cacheKey);
      });

    this.inflightProviderRequests.set(cacheKey, request);
    return request;
  }

  async createSession(input: CreateUpstreamSessionInput = {}) {
    const directory = this.resolveDirectory(input.directory);
    const title = normalizeOptionalString(input.title);
    const parentSessionId = normalizeOptionalString(input.parentSessionId);
    const body =
      title || parentSessionId
        ? {
            ...(parentSessionId ? { parentID: parentSessionId } : {}),
            ...(title ? { title } : {}),
          }
        : undefined;

    return this.requestJson({
      method: "POST",
      path: "/session",
      directory,
      body,
      parse: parseSession,
    });
  }

  async createAssistantMessage(input: CreateUpstreamAssistantMessageInput) {
    const sessionId = requireNonEmptyString(input.sessionId, "sessionId");
    const providerId = requireNonEmptyString(input.providerId, "providerId");
    const modelId = requireNonEmptyString(input.modelId, "modelId");
    const prompt = requireNonEmptyString(input.prompt, "prompt");
    const directory = this.resolveDirectory(input.directory);
    const agent = normalizeOptionalString(input.agent);
    const system = normalizeOptionalString(input.system);

    return this.requestJson({
      method: "POST",
      path: `/session/${encodeURIComponent(sessionId)}/message`,
      directory,
      body: {
        model: {
          providerID: providerId,
          modelID: modelId,
        },
        ...(agent ? { agent } : {}),
        ...(system ? { system } : {}),
        parts: [
          {
            type: "text",
            text: prompt,
          },
        ],
      },
      parse: (value) => parseAssistantMessage(value, `/session/${sessionId}/message`),
    });
  }

  private resolveDirectory(directory: string | null | undefined) {
    return normalizeOptionalString(directory) ?? this.defaultDirectory;
  }

  private buildUrl(path: string, directory: string | null) {
    const requestPath = path.replace(/^\//, "");
    const url = new URL(requestPath, this.baseUrl);

    if (directory) {
      url.searchParams.set("directory", directory);
    }

    return url;
  }

  private buildHeaders(hasBody: boolean) {
    const headers = new Headers({
      accept: "application/json",
    });

    if (hasBody) {
      headers.set("content-type", "application/json");
    }

    if (this.basicAuthHeader) {
      headers.set("authorization", this.basicAuthHeader);
    }

    return headers;
  }

  private async requestJson<T>(input: {
    method: "GET" | "POST";
    path: string;
    directory: string | null;
    body?: unknown;
    parse: (value: unknown) => T;
  }) {
    const requestUrl = this.buildUrl(input.path, input.directory);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let response: Response;
    let responseText = "";

    try {
      response = await this.fetchImpl(requestUrl, {
        method: input.method,
        headers: this.buildHeaders(input.body !== undefined),
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      });
      responseText = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpstreamClientError({
          code: "timeout",
          message: "OpenCode upstream request timed out.",
          retryable: true,
          endpoint: input.path,
        });
      }

      throw new UpstreamClientError({
        code: "network",
        message: "OpenCode upstream is unreachable.",
        retryable: true,
        endpoint: input.path,
      });
    } finally {
      clearTimeout(timeoutId);
    }
    const responseBody = parseJsonBody(responseText);

    if (!response.ok) {
      throw this.createHttpError(input.path, response.status);
    }

    if (responseBody === undefined) {
      throw new UpstreamClientError({
        code: "invalid_response",
        message: "OpenCode upstream returned an invalid response.",
        endpoint: input.path,
      });
    }

    try {
      return input.parse(responseBody);
    } catch (error) {
      if (isUpstreamClientError(error)) {
        throw error;
      }

      throw new UpstreamClientError({
        code: "invalid_response",
        message: "OpenCode upstream returned an invalid response.",
        endpoint: input.path,
      });
    }
  }

  private createHttpError(endpoint: string, sourceStatus: number) {
    switch (sourceStatus) {
      case 400:
        return new UpstreamClientError({
          code: "bad_request",
          message: "OpenCode upstream rejected the request.",
          endpoint,
          sourceStatus,
        });
      case 401:
      case 403:
        return new UpstreamClientError({
          code: "auth",
          message: "OpenCode upstream rejected authentication.",
          endpoint,
          sourceStatus,
        });
      case 404:
        return new UpstreamClientError({
          code: "not_found",
          message: "OpenCode upstream resource was not found.",
          endpoint,
          sourceStatus,
        });
      case 408:
      case 504:
        return new UpstreamClientError({
          code: "timeout",
          message: "OpenCode upstream request timed out.",
          endpoint,
          retryable: true,
          sourceStatus,
        });
      default:
        return new UpstreamClientError({
          code: "upstream",
          message: "OpenCode upstream request failed.",
          endpoint,
          retryable: sourceStatus >= 500 || sourceStatus === 429,
          sourceStatus,
        });
    }
  }
}

const normalizeOptionalString = (value: string | null | undefined) => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const requireNonEmptyString = (value: string | null | undefined, fieldName: string) => {
  const normalized = normalizeOptionalString(value);

  if (!normalized) {
    throw new TypeError(`${fieldName} must be a non-empty string.`);
  }

  return normalized;
};

const createBasicAuthHeader = (username: string | null, password: string | null) => {
  if (!username && !password) {
    return null;
  }

  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`;
};

const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const expectRecord = (value: unknown, context: string) => {
  if (!isRecord(value)) {
    throw new TypeError(`${context} must be an object.`);
  }

  return value;
};

const expectArray = (value: unknown, context: string) => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array.`);
  }

  return value;
};

const expectString = (value: unknown, context: string) => {
  if (typeof value !== "string") {
    throw new TypeError(`${context} must be a string.`);
  }

  return value;
};

const expectOptionalString = (value: unknown, context: string) => {
  if (value == null) {
    return null;
  }

  return expectString(value, context);
};

const expectNumber = (value: unknown, context: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${context} must be a finite number.`);
  }

  return value;
};

const expectBoolean = (value: unknown, context: string) => {
  if (typeof value !== "boolean") {
    throw new TypeError(`${context} must be a boolean.`);
  }

  return value;
};

const expectStringArray = (value: unknown, context: string) =>
  expectArray(value, context).map((entry, index) => expectString(entry, `${context}[${index}]`));

const expectStringRecord = (value: unknown, context: string) => {
  const record = expectRecord(value, context);

  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, expectString(entry, `${context}.${key}`)]),
  );
};

const parseJsonBody = (value: string) => {
  if (value.trim().length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const parseModelCost = (value: unknown, context: string): UpstreamModelCost => {
  const record = expectRecord(value, context);
  const nestedContextCost = record.context_over_200k ?? record.experimentalOver200K;
  const cache = record.cache == null ? null : expectRecord(record.cache, `${context}.cache`);

  return {
    input: expectNumber(record.input, `${context}.input`),
    output: expectNumber(record.output, `${context}.output`),
    cacheRead:
      cache == null
        ? record.cache_read == null
          ? null
          : expectNumber(record.cache_read, `${context}.cache_read`)
        : expectNumber(cache.read, `${context}.cache.read`),
    cacheWrite:
      cache == null
        ? record.cache_write == null
          ? null
          : expectNumber(record.cache_write, `${context}.cache_write`)
        : expectNumber(cache.write, `${context}.cache.write`),
    contextOver200k:
      nestedContextCost == null ? null : parseModelCost(nestedContextCost, `${context}.context_over_200k`),
  };
};

const parseModality = (value: unknown, context: string): UpstreamModality => {
  const modality = expectString(value, context);

  if (!ALLOWED_MODALITIES.includes(modality as UpstreamModality)) {
    throw new TypeError(`${context} must be one of ${ALLOWED_MODALITIES.join(", ")}.`);
  }

  return modality as UpstreamModality;
};

const parseModelStatus = (value: unknown, context: string): UpstreamModelStatus => {
  const status = expectString(value, context);

  if (!ALLOWED_MODEL_STATUSES.includes(status as UpstreamModelStatus)) {
    throw new TypeError(`${context} must be one of ${ALLOWED_MODEL_STATUSES.join(", ")}.`);
  }

  return status as UpstreamModelStatus;
};

const parseCapabilityModalities = (value: unknown, context: string) => {
  const record = expectRecord(value, context);

  return ALLOWED_MODALITIES.filter((modality) => {
    const entry = record[modality];
    return entry == null ? false : expectBoolean(entry, `${context}.${modality}`);
  });
};

const parseModelModalities = (record: JsonRecord, context: string) => {
  if (record.modalities != null) {
    const modalities = expectRecord(record.modalities, `${context}.modalities`);

    return {
      input: expectArray(modalities.input, `${context}.modalities.input`).map((entry, index) =>
        parseModality(entry, `${context}.modalities.input[${index}]`),
      ),
      output: expectArray(modalities.output, `${context}.modalities.output`).map((entry, index) =>
        parseModality(entry, `${context}.modalities.output[${index}]`),
      ),
    };
  }

  if (record.capabilities != null) {
    const capabilities = expectRecord(record.capabilities, `${context}.capabilities`);

    return {
      input: parseCapabilityModalities(capabilities.input, `${context}.capabilities.input`),
      output: parseCapabilityModalities(capabilities.output, `${context}.capabilities.output`),
    };
  }

  return null;
};

const parseModelCapabilityFlag = (
  record: JsonRecord,
  input: {
    currentField: string;
    legacyField: string;
    context: string;
  },
) => {
  if (record.capabilities != null) {
    const capabilities = expectRecord(record.capabilities, `${input.context}.capabilities`);
    return expectBoolean(capabilities[input.currentField], `${input.context}.capabilities.${input.currentField}`);
  }

  return expectBoolean(record[input.legacyField], `${input.context}.${input.legacyField}`);
};

const parseProviderModel = (value: unknown, context: string): UpstreamModel => {
  const record = expectRecord(value, context);
  const limit = expectRecord(record.limit, `${context}.limit`);
  const provider = record.provider == null ? null : expectRecord(record.provider, `${context}.provider`);
  const api = record.api == null ? null : expectRecord(record.api, `${context}.api`);
  const options = expectRecord(record.options, `${context}.options`);
  const headers = record.headers == null ? {} : expectStringRecord(record.headers, `${context}.headers`);

  return {
    id: expectString(record.id, `${context}.id`),
    name: expectString(record.name, `${context}.name`),
    releaseDate: expectString(record.release_date, `${context}.release_date`),
    attachment: parseModelCapabilityFlag(record, {
      currentField: "attachment",
      legacyField: "attachment",
      context,
    }),
    reasoning: parseModelCapabilityFlag(record, {
      currentField: "reasoning",
      legacyField: "reasoning",
      context,
    }),
    temperature: parseModelCapabilityFlag(record, {
      currentField: "temperature",
      legacyField: "temperature",
      context,
    }),
    toolCall: parseModelCapabilityFlag(record, {
      currentField: "toolcall",
      legacyField: "tool_call",
      context,
    }),
    limit: {
      context: expectNumber(limit.context, `${context}.limit.context`),
      output: expectNumber(limit.output, `${context}.limit.output`),
    },
    cost: record.cost == null ? null : parseModelCost(record.cost, `${context}.cost`),
    modalities: parseModelModalities(record, context),
    experimental: record.experimental == null ? false : expectBoolean(record.experimental, `${context}.experimental`),
    status: record.status == null ? null : parseModelStatus(record.status, `${context}.status`),
    options,
    headers,
    providerPackageName:
      (api == null ? null : expectOptionalString(api.npm, `${context}.api.npm`)) ??
      (provider == null ? null : expectOptionalString(provider.npm, `${context}.provider.npm`)),
  };
};

const parseProviderCatalog = (value: unknown, fetchedAt: number): UpstreamProviderCatalog => {
  const record = expectRecord(value, "provider catalog");
  const providers = expectArray(record.all, "provider catalog.all");
  const connected = new Set(expectStringArray(record.connected, "provider catalog.connected"));
  const defaultModelsByProvider = expectStringRecord(record.default, "provider catalog.default");

  return {
    fetchedAt,
    defaultModelsByProvider,
    providers: providers.map((entry, index) => {
      const provider = expectRecord(entry, `provider catalog.all[${index}]`);
      const models = expectRecord(provider.models, `provider catalog.all[${index}].models`);
      const providerId = expectString(provider.id, `provider catalog.all[${index}].id`);
      const isConnected = connected.has(providerId);

      return {
        id: providerId,
        name: expectString(provider.name, `provider catalog.all[${index}].name`),
        api: expectOptionalString(provider.api, `provider catalog.all[${index}].api`),
        env: expectStringArray(provider.env, `provider catalog.all[${index}].env`),
        npm: expectOptionalString(provider.npm, `provider catalog.all[${index}].npm`),
        connected: isConnected,
        defaultModelId: defaultModelsByProvider[providerId] ?? null,
        // Disconnected providers are never advertised by the sidecar, so we can
        // skip their model normalization and avoid failing closed on irrelevant
        // upstream schema drift.
        models: isConnected
          ? Object.entries(models).map(([modelKey, modelValue]) =>
              parseProviderModel(modelValue, `provider catalog.all[${index}].models.${modelKey}`),
            )
          : [],
      };
    }),
  };
};

const parseSession = (value: unknown): UpstreamSession => {
  const record = expectRecord(value, "session");
  const time = expectRecord(record.time, "session.time");
  const share = record.share == null ? null : expectRecord(record.share, "session.share");

  return {
    id: expectString(record.id, "session.id"),
    projectId: expectString(record.projectID, "session.projectID"),
    directory: expectString(record.directory, "session.directory"),
    parentId: record.parentID == null ? null : expectString(record.parentID, "session.parentID"),
    title: expectString(record.title, "session.title"),
    version: expectString(record.version, "session.version"),
    shareUrl: share == null ? null : expectString(share.url, "session.share.url"),
    createdAt: expectNumber(time.created, "session.time.created"),
    updatedAt: expectNumber(time.updated, "session.time.updated"),
    compactingAt: time.compacting == null ? null : expectNumber(time.compacting, "session.time.compacting"),
  };
};

const parseAssistantPart = (value: unknown, context: string): UpstreamAssistantMessagePart => {
  const record = expectRecord(value, context);
  const type = expectString(record.type, `${context}.type`);
  const id = expectString(record.id, `${context}.id`);

  if (type === "text") {
    return {
      id,
      type,
      text: expectString(record.text, `${context}.text`),
      ignored: record.ignored == null ? false : expectBoolean(record.ignored, `${context}.ignored`),
      synthetic: record.synthetic == null ? false : expectBoolean(record.synthetic, `${context}.synthetic`),
    };
  }

  return {
    id,
    type,
    raw: record,
  };
};

const parseAssistantPayloadError = (value: unknown, endpoint: string): UpstreamClientError => {
  const record = expectRecord(value, "assistant message error");
  const name = expectString(record.name, "assistant message error.name");
  const data = record.data == null ? {} : expectRecord(record.data, "assistant message error.data");
  const sourceStatus =
    data.statusCode == null ? null : expectNumber(data.statusCode, "assistant message error.data.statusCode");

  if (name === "ProviderAuthError" || sourceStatus === 401 || sourceStatus === 403) {
    return new UpstreamClientError({
      code: "auth",
      message: "OpenCode upstream rejected authentication.",
      endpoint,
      sourceStatus: sourceStatus ?? 401,
      upstreamErrorName: name,
    });
  }

  if (sourceStatus === 408 || sourceStatus === 504) {
    return new UpstreamClientError({
      code: "timeout",
      message: "OpenCode upstream request timed out.",
      endpoint,
      retryable: true,
      sourceStatus,
      upstreamErrorName: name,
    });
  }

  if (sourceStatus === 404) {
    return new UpstreamClientError({
      code: "not_found",
      message: "OpenCode upstream resource was not found.",
      endpoint,
      sourceStatus,
      upstreamErrorName: name,
    });
  }

  if (sourceStatus === 400) {
    return new UpstreamClientError({
      code: "bad_request",
      message: "OpenCode upstream rejected the request.",
      endpoint,
      sourceStatus,
      upstreamErrorName: name,
    });
  }

  return new UpstreamClientError({
    code: "upstream",
    message: "OpenCode upstream request failed.",
    endpoint,
    retryable: sourceStatus == null || sourceStatus >= 500 || sourceStatus === 429,
    sourceStatus,
    upstreamErrorName: name,
  });
};

const readOptionalFiniteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const parseOptionalAssistantTokens = (value: unknown): UpstreamAssistantMessage["tokens"] => {
  if (!isRecord(value)) {
    return null;
  }

  const cache = isRecord(value.cache) ? value.cache : null;
  const input = readOptionalFiniteNumber(value.input);
  const output = readOptionalFiniteNumber(value.output);
  const reasoning = readOptionalFiniteNumber(value.reasoning);
  const cacheRead = readOptionalFiniteNumber(cache?.read);
  const cacheWrite = readOptionalFiniteNumber(cache?.write);

  if (input == null || output == null || reasoning == null || cacheRead == null || cacheWrite == null) {
    return null;
  }

  return {
    input,
    output,
    reasoning,
    cache: {
      read: cacheRead,
      write: cacheWrite,
    },
  };
};

const parseAssistantMessage = (value: unknown, endpoint: string): UpstreamAssistantMessage => {
  const record = expectRecord(value, "assistant message response");
  const info = expectRecord(record.info, "assistant message response.info");

  if (info.error != null) {
    throw parseAssistantPayloadError(info.error, endpoint);
  }

  const role = expectString(info.role, "assistant message response.info.role");
  if (role !== "assistant") {
    throw new TypeError("assistant message response.info.role must be assistant.");
  }

  const time = expectRecord(info.time, "assistant message response.info.time");
  const path = expectRecord(info.path, "assistant message response.info.path");
  const parts = expectArray(record.parts, "assistant message response.parts").map((entry, index) =>
    parseAssistantPart(entry, `assistant message response.parts[${index}]`),
  );

  return {
    id: expectString(info.id, "assistant message response.info.id"),
    sessionId: expectString(info.sessionID, "assistant message response.info.sessionID"),
    parentId: expectString(info.parentID, "assistant message response.info.parentID"),
    providerId: expectString(info.providerID, "assistant message response.info.providerID"),
    modelId: expectString(info.modelID, "assistant message response.info.modelID"),
    role: "assistant",
    mode: expectString(info.mode, "assistant message response.info.mode"),
    path: {
      cwd: expectString(path.cwd, "assistant message response.info.path.cwd"),
      root: expectString(path.root, "assistant message response.info.path.root"),
    },
    finish: info.finish == null ? null : expectString(info.finish, "assistant message response.info.finish"),
    createdAt: expectNumber(time.created, "assistant message response.info.time.created"),
    completedAt: time.completed == null ? null : expectNumber(time.completed, "assistant message response.info.time.completed"),
    cost: readOptionalFiniteNumber(info.cost),
    tokens: parseOptionalAssistantTokens(info.tokens),
    text: parts
      .filter((part): part is Extract<UpstreamAssistantMessagePart, { type: "text" }> => part.type === "text")
      .filter((part) => !part.ignored)
      .map((part) => part.text)
      .join(""),
    parts,
  };
};
