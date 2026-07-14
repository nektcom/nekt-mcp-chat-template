import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createOpenAI } from '@ai-sdk/openai';
import type { JSONValue, LanguageModel } from 'ai';

/**
 * Strip the `id` field that @ai-sdk/google injects into `functionCall` /
 * `functionResponse` parts when it serializes tool-call history.
 *
 * On the second step of an agentic loop (model calls a tool, we feed the
 * result back), the provider replays the prior tool call/result and writes
 * `{ functionCall: { id: <toolCallId>, name, args } }`. The Gemini/Vertex REST
 * endpoint rejects that unknown field:
 *   Invalid JSON payload received. Unknown name "id" at
 *   'contents[1].parts[0].function_call': Cannot find field.
 * Gemini matches responses to calls by name + order, not id, so dropping it on
 * the way out is safe for our single-tool-at-a-time usage. Mirrors the
 * httpOnlyFetch shim in lib/mcp.ts.
 */
const stripFunctionCallIds: typeof fetch = async (input, init) => {
  if (typeof init?.body === 'string') {
    try {
      const payload = JSON.parse(init.body);
      for (const content of payload?.contents ?? []) {
        for (const part of content?.parts ?? []) {
          if (part?.functionCall) delete part.functionCall.id;
          if (part?.functionResponse) delete part.functionResponse.id;
        }
      }
      init = { ...init, body: JSON.stringify(payload) };
    } catch {
      // Non-JSON body (or unexpected shape) — pass through untouched.
    }
  }
  return fetch(input, init);
};

/**
 * LLM configuration — env-driven, one model per deployment.
 *
 * The agentic loop in `api/chat/route.ts` is provider-agnostic; everything
 * provider-specific (which SDK, which auth, which reasoning options) lives
 * here. Configuration comes from three generic env vars — there are NO
 * defaults and NO fallbacks by design: a deployment must state its provider,
 * model, and key explicitly, and a missing value fails every chat request
 * with an actionable error instead of silently picking a model for you.
 *
 *   LLM_PROVIDER  one of: openai | anthropic | google | vertex
 *   LLM_MODEL     provider-specific model id (e.g. gpt-5.1, claude-opus-4-8,
 *                 gemini-3.5-flash)
 *   LLM_API_KEY   the provider API key. Passed explicitly to the SDK factory —
 *                 provider-specific env vars like ANTHROPIC_API_KEY or
 *                 GOOGLE_GENERATIVE_AI_API_KEY are NOT read.
 *
 * Provider notes:
 *   - openai:    standard platform.openai.com API key.
 *   - anthropic: standard console.anthropic.com API key.
 *   - google:    Google AI Studio key (free tier exists; Pro models are
 *                paid-only and 429 with limit:0 on the free tier).
 *   - vertex:    either LLM_API_KEY set to a Vertex AI *express-mode* key
 *                (from Vertex AI Studio — distinct from an AI Studio key,
 *                project/location not required), or leave LLM_API_KEY unset
 *                and use Application Default Credentials with
 *                GOOGLE_VERTEX_PROJECT + GOOGLE_VERTEX_LOCATION
 *                (`gcloud auth application-default login` or
 *                GOOGLE_APPLICATION_CREDENTIALS). Vertex is paid — no free tier.
 *
 * Optional:
 *   LLM_REASONING=true  opts in to reasoning/thinking output for openai and
 *                 anthropic (see chatConfig below). google/vertex reasoning is
 *                 always requested — Gemini ignores it where unsupported.
 */
export const LLM_PROVIDERS = ['openai', 'anthropic', 'google', 'vertex'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * Invalid or missing LLM env config. `api/chat/route.ts` catches this and
 * returns it as a 500 JSON error, so misconfiguration is visible in the chat
 * UI instead of crashing the process at import time.
 */
export class LlmConfigError extends Error {
  name = 'LlmConfigError';
}

/** Options streamText forwards under `providerOptions`, keyed by provider. */
type ProviderOptions = Record<string, Record<string, JSONValue>>;

const MODEL_EXAMPLES: Record<LlmProvider, string> = {
  openai: 'gpt-5.1',
  anthropic: 'claude-opus-4-8',
  google: 'gemini-3.5-flash',
  vertex: 'gemini-3.5-flash',
};

/**
 * Read + validate the LLM env config and build everything the chat route
 * needs: the model instance and the per-provider `providerOptions` for
 * streamText. Called per request — provider factories are cheap, and
 * validating here (not at module scope) means a bad config surfaces as a
 * clean JSON error on the request instead of a build/boot crash.
 *
 * Reasoning output (rendered by the UI as collapsible "thinking"):
 *   - google/vertex: always request `thinkingConfig.includeThoughts` — without
 *     it Gemini returns opaque thoughtSignatures and no readable reasoning.
 *     Harmless on non-thinking Gemini models.
 *   - anthropic/openai: gated behind LLM_REASONING=true because the options
 *     are rejected by non-reasoning models (OpenAI errors on reasoningSummary
 *     for e.g. gpt-4.1; Anthropic errors on adaptive thinking before
 *     claude-sonnet-4-6). When enabled: anthropic gets adaptive thinking with
 *     display:'summarized' (required from claude-opus-4-7 on, where thinking
 *     text is otherwise omitted); openai gets reasoningSummary:'auto'.
 */
export function chatConfig(): {
  provider: LlmProvider;
  model: LanguageModel;
  providerOptions: ProviderOptions;
} {
  const provider = process.env.LLM_PROVIDER;
  if (!provider) {
    throw new LlmConfigError(
      `Missing LLM_PROVIDER. Set it to one of: ${LLM_PROVIDERS.join(', ')}. See .env.example.`,
    );
  }
  if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
    throw new LlmConfigError(
      `Invalid LLM_PROVIDER "${provider}". Supported values: ${LLM_PROVIDERS.join(', ')}. See .env.example.`,
    );
  }

  const modelId = process.env.LLM_MODEL;
  if (!modelId) {
    throw new LlmConfigError(
      `Missing LLM_MODEL. Set it to a model id for the "${provider}" provider (e.g. ${MODEL_EXAMPLES[provider as LlmProvider]}). See .env.example.`,
    );
  }

  // Empty string counts as missing — an empty key would silently put Vertex
  // into (blank-key) express mode instead of falling back to ADC.
  const apiKey = process.env.LLM_API_KEY || undefined;

  const reasoning = process.env.LLM_REASONING === 'true';

  switch (provider as LlmProvider) {
    case 'openai': {
      requireKey(apiKey, provider);
      return {
        provider: 'openai',
        model: createOpenAI({ apiKey })(modelId),
        providerOptions: reasoning
          ? { openai: { reasoningSummary: 'auto' } }
          : {},
      };
    }
    case 'anthropic': {
      requireKey(apiKey, provider);
      return {
        provider: 'anthropic',
        model: createAnthropic({ apiKey })(modelId),
        providerOptions: reasoning
          ? { anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } }
          : {},
      };
    }
    case 'google': {
      requireKey(apiKey, provider);
      return {
        provider: 'google',
        model: createGoogleGenerativeAI({ apiKey, fetch: stripFunctionCallIds })(modelId),
        providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
      };
    }
    case 'vertex': {
      const project = process.env.GOOGLE_VERTEX_PROJECT || undefined;
      const location = process.env.GOOGLE_VERTEX_LOCATION || undefined;
      if (!apiKey && !(project && location)) {
        throw new LlmConfigError(
          'Missing Vertex credentials. Either set LLM_API_KEY to a Vertex AI express-mode key, ' +
            'or set GOOGLE_VERTEX_PROJECT and GOOGLE_VERTEX_LOCATION and authenticate with ' +
            'Application Default Credentials (gcloud auth application-default login, or ' +
            'GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account JSON). See .env.example.',
        );
      }
      return {
        provider: 'vertex',
        // Express mode when apiKey is set; otherwise ADC with project/location.
        model: createVertex({ apiKey, project, location, fetch: stripFunctionCallIds })(modelId),
        providerOptions: { vertex: { thinkingConfig: { includeThoughts: true } } },
      };
    }
  }
}

function requireKey(apiKey: string | undefined, provider: string): asserts apiKey is string {
  if (!apiKey) {
    throw new LlmConfigError(
      `Missing LLM_API_KEY. The "${provider}" provider requires an API key. See .env.example.`,
    );
  }
}
