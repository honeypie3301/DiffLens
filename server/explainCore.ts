import { GoogleGenAI, ThinkingLevel } from '@google/genai';

export interface ExplainPayload {
  title?: string;
  language?: string;
  hunksPatch: string;
  stats: {
    added: number;
    removed: number;
    unchanged: number;
    totalLeftLines: number;
    totalRightLines: number;
    hunkCount: number;
  };
  focus?: 'concise' | 'detailed' | 'risks';
}

export interface ExplainResult {
  summary: string;
  modelUsed: string;
  chunkCount: number;
}

const MAX_SINGLE_PASS_CHARS = 95000;
const CHUNK_CHAR_BUDGET = 65000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatReadableApiError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? 'Unknown AI error');
  try {
    const jsonStart = msg.indexOf('{');
    if (jsonStart !== -1) {
      const parsed = JSON.parse(msg.slice(jsonStart));
      const inner = parsed?.error?.message || parsed?.message;
      if (typeof inner === 'string' && inner.trim()) {
        return inner.trim();
      }
    }
  } catch {
    // Keep original message
  }
  return msg;
}

function isTransientCapacityError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('resource_exhausted') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('timed out') ||
    msg.includes('timeout')
  );
}

function extractRetryDelayMs(err: unknown): number | null {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const secMatch = raw.match(/retry in\s+([\d.]+)s/i) || raw.match(/"retryDelay"\s*:\s*"(\d+)s"/i);
  if (!secMatch) return null;
  const seconds = parseFloat(secMatch[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(16000, Math.max(1000, Math.ceil(seconds * 1000) + 300));
}

async function tryGeminiModels(
  contents: string,
  systemInstruction: string
): Promise<{ text: string; modelUsed: string }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const attemptSchedule: Array<{ model: string; level: ThinkingLevel }> = [
    { model: 'gemini-4-hydrogen', level: ThinkingLevel.LOW },
    { model: 'gemini-3.1-flash-lite', level: ThinkingLevel.MINIMAL },
    { model: 'gemini-4-hydrogen', level: ThinkingLevel.LOW },
  ];

  let lastError: unknown = null;

  for (let i = 0; i < attemptSchedule.length; i++) {
    const attempt = attemptSchedule[i];
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents,
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: attempt.level },
        },
      });
      const text = (response.text ?? '').trim();
      if (text) {
        return { text, modelUsed: attempt.model };
      }
    } catch (err: unknown) {
      lastError = err;
      const msg = formatReadableApiError(err).toLowerCase();
      if (msg.includes('free tier is not available') || msg.includes('api_key_invalid')) {
        break;
      }
      if (i < attemptSchedule.length - 1) {
        if (i === 0 && isTransientCapacityError(err)) {
          await sleep(250);
          continue;
        }
        if (isTransientCapacityError(err)) {
          const retryMs = extractRetryDelayMs(err) ?? 1800 + Math.floor(Math.random() * 400);
          await sleep(retryMs);
          continue;
        }
        await sleep(300);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Gemini models failed.');
}

interface OpenAICompatProvider {
  name: string;
  endpoint: string;
  apiKeyEnv: string;
  models: string[];
  extraHeaders?: Record<string, string>;
}

const FALLBACK_PROVIDERS: OpenAICompatProvider[] = [
  {
    name: 'Cerebras',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    models: ['llama3.1-8b', 'llama-3.3-70b'],
  },
  {
    name: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKeyEnv: 'GROQ_API_KEY',
    models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
  },
  {
    name: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [
      'openai/gpt-oss-120b',
      'meta-llama/llama-3.3-70b-instruct:free',
      'openrouter/free',
    ],
    extraHeaders: {
      'X-Title': 'DiffLens',
    },
  },
  {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat'],
  },
  {
    name: 'Mistral',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    apiKeyEnv: 'MISTRAL_API_KEY',
    models: ['mistral-small-latest'],
  },
  {
    name: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: ['gpt-4.1-nano', 'gpt-4o-mini'],
  },
];

async function tryCustomGptOssFallback(
  contents: string,
  systemInstruction: string
): Promise<{ text: string; modelUsed: string } | null> {
  const apiKey = process.env.GPT_OSS_API_KEY?.trim();
  if (!apiKey) return null;

  const baseUrl = (process.env.GPT_OSS_BASE_URL || 'https://openrouter.ai/api/v1').replace(
    /\/+$/,
    ''
  );
  const model = process.env.GPT_OSS_MODEL || 'openai/gpt-oss-120b';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: contents },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Fallback (${model}): ${formatReadableApiError(errText)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  if (!text) return null;
  return { text, modelUsed: model };
}

async function tryOpenAICompatProviders(
  contents: string,
  systemInstruction: string
): Promise<{ text: string; modelUsed: string } | null> {
  const errors: string[] = [];

  try {
    const gptOss = await tryCustomGptOssFallback(contents, systemInstruction);
    if (gptOss) return gptOss;
  } catch (err: unknown) {
    errors.push(formatReadableApiError(err));
  }

  for (const provider of FALLBACK_PROVIDERS) {
    const apiKey = process.env[provider.apiKeyEnv]?.trim();
    if (!apiKey) continue;

    for (const model of provider.models) {
      try {
        const res = await fetch(provider.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            ...(provider.extraHeaders ?? {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemInstruction },
              { role: 'user', content: contents },
            ],
            temperature: 0.2,
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          errors.push(`${provider.name} (${model}): ${formatReadableApiError(errText)}`);
          continue;
        }

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const text = (data.choices?.[0]?.message?.content ?? '').trim();
        if (text) {
          return { text, modelUsed: `${provider.name.toLowerCase()}/${model}` };
        }
      } catch (err: unknown) {
        errors.push(`${provider.name} (${model}): ${formatReadableApiError(err)}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }
  return null;
}

async function generateWithFallbackChain(
  contents: string,
  systemInstruction: string
): Promise<{ text: string; modelUsed: string }> {
  const errors: string[] = [];

  if (process.env.GEMINI_API_KEY?.trim()) {
    try {
      return await tryGeminiModels(contents, systemInstruction);
    } catch (err: unknown) {
      errors.push(formatReadableApiError(err));
    }
  } else {
    errors.push('GEMINI_API_KEY is not configured on the server.');
  }

  try {
    const fallbackResult = await tryOpenAICompatProviders(contents, systemInstruction);
    if (fallbackResult) return fallbackResult;
  } catch (err: unknown) {
    errors.push(formatReadableApiError(err));
  }

  const configuredCount =
    (process.env.GEMINI_API_KEY?.trim() ? 1 : 0) +
    (process.env.GPT_OSS_API_KEY?.trim() ? 1 : 0) +
    FALLBACK_PROVIDERS.filter((p) => Boolean(process.env[p.apiKeyEnv]?.trim())).length;

  if (configuredCount === 0) {
    throw new Error(
      'MISSING_API_KEY: Server AI key is not configured. Set GEMINI_API_KEY in Settings > Secrets or Vercel Environment Variables.'
    );
  }

  const firstErr = errors[0] || 'AI request failed.';
  if (firstErr.toLowerCase().includes('free tier is not available')) {
    throw new Error(
      'The Gemini API free tier is not available on this Google Cloud project. Enable billing on the project or attach a billed GEMINI_API_KEY in Settings > Secrets so server-side AI works without prompting visitors.'
    );
  }

  throw new Error(firstErr);
}

function splitPatchIntoChunks(patch: string, budget: number): string[] {
  if (patch.length <= budget) {
    return [patch];
  }

  const hunkBlocks = patch.split(/(?=^@@ )/m);
  const chunks: string[] = [];
  let current = '';

  for (const block of hunkBlocks) {
    if (block.length > budget) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < block.length; i += budget) {
        chunks.push(block.slice(i, i + budget));
      }
      continue;
    }

    if (current.length + block.length > budget && current.length > 0) {
      chunks.push(current);
      current = block;
    } else {
      current += block;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export async function explainDiff(payload: ExplainPayload): Promise<ExplainResult> {
  const patch = (payload.hunksPatch ?? '').trim();

  if (!patch) {
    return {
      summary: 'No changes detected between the two inputs.',
      modelUsed: 'none',
      chunkCount: 0,
    };
  }

  const focusInstruction =
    payload.focus === 'risks'
      ? 'Focus primarily on potential bugs, regressions, edge cases, race conditions, or breaking behavioral changes.'
      : payload.focus === 'detailed'
      ? 'Provide a clear high-level overview followed by a hunk-by-hunk technical breakdown.'
      : 'Keep the explanation concise, scannable, and direct using short bullet points.';

  const systemInstruction = [
    'You are a senior software engineer reviewing a code/text diff.',
    'Explain what actually changed based strictly on the provided diff hunks (+ added, - removed).',
    'Cite exact symbol names, methods, variables, and line numbers when present.',
    'Do not include conversational filler, pleasantries, or speculative claims.',
    focusInstruction,
  ].join(' ');

  const metadataHeader = [
    `Title: ${payload.title || 'Untitled diff'}`,
    `Language: ${payload.language || 'auto'}`,
    `Stats: +${payload.stats.added} added, -${payload.stats.removed} removed across ${payload.stats.hunkCount} hunk(s) (Left: ${payload.stats.totalLeftLines} lines, Right: ${payload.stats.totalRightLines} lines)`,
  ].join('\n');

  if (patch.length <= MAX_SINGLE_PASS_CHARS) {
    const prompt = `${metadataHeader}\n\nDiff Hunks:\n${patch}`;
    const result = await generateWithFallbackChain(prompt, systemInstruction);
    return {
      summary: result.text,
      modelUsed: result.modelUsed,
      chunkCount: 1,
    };
  }

  const chunks = splitPatchIntoChunks(patch, CHUNK_CHAR_BUDGET);
  const partialSummaries: string[] = [];
  let modelUsed = 'gemini-4-hydrogen';

  for (let i = 0; i < chunks.length; i += 2) {
    const batch = chunks.slice(i, i + 2);
    const results = await Promise.all(
      batch.map((chunk, idx) =>
        generateWithFallbackChain(
          `${metadataHeader}\nChunk ${i + idx + 1} of ${chunks.length}:\n\n${chunk}`,
          'Summarize the exact code or text modifications in this diff chunk concisely with symbol names and line ranges.'
        )
      )
    );
    for (const r of results) {
      partialSummaries.push(r.text);
      modelUsed = r.modelUsed;
    }
  }

  const synthesisPrompt = [
    metadataHeader,
    `Synthesize these ${partialSummaries.length} diff chunk summaries into a single cohesive explanation:`,
    partialSummaries.map((s, idx) => `--- Part ${idx + 1} ---\n${s}`).join('\n\n'),
  ].join('\n\n');

  const finalResult = await generateWithFallbackChain(synthesisPrompt, systemInstruction);
  return {
    summary: finalResult.text,
    modelUsed: finalResult.modelUsed || modelUsed,
    chunkCount: chunks.length,
  };
}
