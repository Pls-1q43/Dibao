import {
  EmbeddingProviderError,
  type EmbeddingInput,
  type EmbeddingProviderAdapter,
  type EmbeddingProviderConfig,
  type EmbeddingTestResult,
  type EmbeddingVector
} from "./types.js";
import { providerHttpError, providerNetworkError } from "./provider-http-errors.js";

export const GEMINI_TEST_TEXT = "Dibao embedding provider test";
export const GEMINI_TIMEOUT_MS = 30_000;

type GeminiAdapterOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

type GeminiEmbeddingResponse = {
  embeddings?: Array<{
    values?: unknown;
  }>;
};

export class GeminiEmbeddingAdapter implements EmbeddingProviderAdapter {
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GeminiAdapterOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS;
  }

  async test(provider: EmbeddingProviderConfig): Promise<EmbeddingTestResult> {
    const startedAt = Date.now();
    const [result] = await this.embedBatch({
      provider,
      items: [
        {
          id: "test",
          text: GEMINI_TEST_TEXT
        }
      ]
    });

    if (!result) {
      throw new EmbeddingProviderError("Gemini response did not include a test embedding", false);
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
    const vectors = parseGeminiEmbeddingResponse(response, input.items);

    for (const vector of vectors) {
      if (vector.vector.length !== input.provider.dimension) {
        throw new EmbeddingProviderError(
          `Gemini returned dimension ${vector.vector.length}; expected ${input.provider.dimension}`,
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

  private async postEmbeddings(provider: EmbeddingProviderConfig, texts: string[]): Promise<unknown> {
    if (!provider.apiKey) {
      throw new EmbeddingProviderError("Gemini API key is required", false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const model = modelResourceName(provider.model);

    try {
      const response = await this.fetcher(embeddingEndpoint(provider, model), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": provider.apiKey
        },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model,
            ...(shouldRequestGeminiOutputDimensionality(provider.model)
              ? { outputDimensionality: provider.dimension }
              : {}),
            content: {
              parts: [{ text }]
            }
          }))
        }),
        signal: controller.signal
      });

      const text = await response.text();
      const payload = parseJson(text);

      if (!response.ok) {
        throw providerHttpError({
          providerLabel: "Gemini",
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

      throw providerNetworkError({ providerLabel: "Gemini", error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function embeddingEndpoint(provider: EmbeddingProviderConfig, model: string): string {
  if (!provider.baseUrl) {
    throw new EmbeddingProviderError("Gemini baseUrl is required", false);
  }

  return `${provider.baseUrl.replace(/\/+$/u, "")}/${model}:batchEmbedContents`;
}

function modelResourceName(model: string): string {
  const trimmed = model.trim().replace(/^\/+/u, "");
  return trimmed.startsWith("models/") ? trimmed : `models/${trimmed}`;
}

function shouldRequestGeminiOutputDimensionality(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/^models\//u, "");
  return normalized.startsWith("gemini-embedding-") || normalized === "text-embedding-004";
}

function parseGeminiEmbeddingResponse(
  payload: unknown,
  items: EmbeddingInput[]
): EmbeddingVector[] {
  if (!isGeminiEmbeddingResponse(payload) || !Array.isArray(payload.embeddings)) {
    throw new EmbeddingProviderError(
      "Gemini provider returned a malformed response: missing embeddings array",
      false
    );
  }

  if (payload.embeddings.length !== items.length) {
    throw new EmbeddingProviderError(
      `Gemini returned ${payload.embeddings.length} embeddings for ${items.length} inputs`,
      false,
      {
        expectedCount: items.length,
        actualCount: payload.embeddings.length
      }
    );
  }

  return payload.embeddings.map((item, index) => {
    if (!Array.isArray(item.values) || !item.values.every(isFiniteNumber)) {
      throw new EmbeddingProviderError(
        "Gemini provider returned a malformed response: embedding must be a number array",
        false,
        {
          index
        }
      );
    }

    return {
      id: items[index].id,
      vector: item.values
    };
  });
}

function isGeminiEmbeddingResponse(value: unknown): value is GeminiEmbeddingResponse {
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
