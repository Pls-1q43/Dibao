import {
  EmbeddingProviderError,
  type EmbeddingInput,
  type EmbeddingProviderAdapter,
  type EmbeddingProviderConfig,
  type EmbeddingTestResult,
  type EmbeddingVector
} from "./types.js";
import { providerHttpError, providerNetworkError } from "./provider-http-errors.js";

export const OPENAI_COMPATIBLE_TEST_TEXT = "Dibao embedding provider test";
export const OPENAI_COMPATIBLE_TIMEOUT_MS = 30_000;

type OpenAiCompatibleAdapterOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

type OpenAiEmbeddingResponse = {
  data?: Array<{
    index?: number;
    embedding?: unknown;
  }>;
};

export class OpenAiCompatibleEmbeddingAdapter implements EmbeddingProviderAdapter {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleAdapterOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? OPENAI_COMPATIBLE_TIMEOUT_MS;
  }

  async test(provider: EmbeddingProviderConfig): Promise<EmbeddingTestResult> {
    const startedAt = Date.now();
    const [result] = await this.embedBatch({
      provider,
      items: [
        {
          id: "test",
          text: OPENAI_COMPATIBLE_TEST_TEXT
        }
      ]
    });

    if (!result) {
      throw new EmbeddingProviderError("Provider response did not include a test embedding", false);
    }

    return {
      dimension: result.vector.length,
      latencyMs: Math.max(0, Date.now() - startedAt)
    };
  }

  async embedBatch(input: {
    provider: EmbeddingProviderConfig;
    items: EmbeddingInput[];
  }): Promise<EmbeddingVector[]> {
    if (input.items.length === 0) {
      return [];
    }

    const response = await this.postEmbeddings(input.provider, input.items.map((item) => item.text));
    const vectors = parseOpenAiEmbeddingResponse(response, input.items);

    for (const vector of vectors) {
      if (vector.vector.length !== input.provider.dimension) {
        throw new EmbeddingProviderError(
          `Provider returned dimension ${vector.vector.length}; expected ${input.provider.dimension}`,
          false,
          {
            expectedDimension: input.provider.dimension,
            actualDimension: vector.vector.length
          }
        );
      }
    }

    return vectors;
  }

  private async postEmbeddings(
    provider: EmbeddingProviderConfig,
    texts: string[]
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetcher(embeddingEndpoint(provider), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {})
        },
        body: JSON.stringify(embeddingRequestBody(provider, texts)),
        signal: controller.signal
      });

      const text = await response.text();
      const payload = parseJson(text);

      if (!response.ok) {
        throw providerHttpError({
          providerLabel: "OpenAI-compatible",
          status: response.status,
          payload,
          text
        });
      }

      return payload;
    } catch (error) {
      if (error instanceof EmbeddingProviderError) {
        throw error;
      }

      throw providerNetworkError({ providerLabel: "OpenAI-compatible", error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function embeddingRequestBody(
  provider: EmbeddingProviderConfig,
  texts: string[]
): { model: string; input: string[]; dimensions?: number } {
  return {
    model: provider.model,
    input: texts,
    ...(shouldRequestOpenAiCompatibleDimensions(provider)
      ? { dimensions: provider.dimension }
      : {})
  };
}

function shouldRequestOpenAiCompatibleDimensions(provider: EmbeddingProviderConfig): boolean {
  const model = provider.model.trim().toLowerCase();
  if (model.startsWith("gemini-embedding")) {
    return true;
  }

  if (!provider.baseUrl) {
    return false;
  }

  try {
    const url = new URL(provider.baseUrl);
    if (url.hostname.endsWith("googleapis.com") && url.pathname.includes("/openai")) {
      return true;
    }
    return url.hostname === "api.openai.com" &&
      (model === "text-embedding-3-small" || model === "text-embedding-3-large");
  } catch {
    return false;
  }
}

function embeddingEndpoint(provider: EmbeddingProviderConfig): string {
  if (!provider.baseUrl) {
    throw new EmbeddingProviderError("Provider baseUrl is required", false);
  }

  return `${provider.baseUrl.replace(/\/+$/u, "")}/embeddings`;
}

function parseOpenAiEmbeddingResponse(
  payload: unknown,
  items: EmbeddingInput[]
): EmbeddingVector[] {
  if (!isOpenAiEmbeddingResponse(payload) || !Array.isArray(payload.data)) {
    throw new EmbeddingProviderError(
      "OpenAI-compatible provider returned a malformed response: missing data array",
      false
    );
  }

  if (payload.data.length !== items.length) {
    throw new EmbeddingProviderError(
      `Provider returned ${payload.data.length} embeddings for ${items.length} inputs`,
      false,
      {
        expectedCount: items.length,
        actualCount: payload.data.length
      }
    );
  }

  return payload.data.map((item, index) => {
    if (!Array.isArray(item.embedding) || !item.embedding.every(isFiniteNumber)) {
      throw new EmbeddingProviderError(
        "OpenAI-compatible provider returned a malformed response: embedding must be a number array",
        false,
        {
          index
        }
      );
    }

    return {
      id: items[index].id,
      vector: item.embedding
    };
  });
}

function isOpenAiEmbeddingResponse(value: unknown): value is OpenAiEmbeddingResponse {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseJson(text: string): unknown {
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
