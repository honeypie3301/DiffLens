interface TextGenPipeline {
  (
    messages: Array<{ role: string; content: string }>,
    options: {
      max_new_tokens: number;
      do_sample: boolean;
      temperature?: number;
      streamer?: unknown;
    }
  ): Promise<Array<{ generated_text?: Array<{ role?: string; content?: string }> | string }>>;
  tokenizer?: unknown;
}

interface WorkerRunRequest {
  type: 'run';
  id: number;
  prompt: string;
  systemPrompt: string;
  modelId: string;
  device: 'webgpu' | 'wasm';
  dtype: 'q4' | 'q4f16';
}

interface WorkerClearRequest {
  type: 'clear';
}

type WorkerRequest = WorkerRunRequest | WorkerClearRequest;

const CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';

let cachedGenerator: TextGenPipeline | null = null;
let cachedKey: string | null = null;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'clear') {
    cachedGenerator = null;
    cachedKey = null;
    self.postMessage({ type: 'cleared' });
    return;
  }

  const { id, prompt, systemPrompt, modelId, device, dtype } = msg;
  const targetKey = `${modelId}:${device}:${dtype}`;

  try {
    const transformers = (await import(/* @vite-ignore */ CDN_URL)) as {
      pipeline: (
        task: string,
        model: string,
        opts: Record<string, unknown>
      ) => Promise<TextGenPipeline>;
      TextStreamer?: new (
        tokenizer: unknown,
        opts: {
          skip_prompt?: boolean;
          skip_special_tokens?: boolean;
          callback_function?: (text: string) => void;
        }
      ) => unknown;
      env?: {
        allowLocalModels?: boolean;
        allowRemoteModels?: boolean;
        useBrowserCache?: boolean;
        backends?: { onnx?: { wasm?: { numThreads?: number } } };
      };
    };

    if (!cachedGenerator || cachedKey !== targetKey) {
      self.postMessage({ type: 'status', id, status: `Loading ${modelId.split('/')[1]} (${device})...` });

      if (transformers.env) {
        transformers.env.allowLocalModels = false;
        transformers.env.allowRemoteModels = true;
        transformers.env.useBrowserCache = true;
        if (
          typeof self !== 'undefined' &&
          (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated &&
          transformers.env.backends?.onnx?.wasm
        ) {
          transformers.env.backends.onnx.wasm.numThreads = Math.min(
            4,
            navigator.hardwareConcurrency || 2
          );
        }
      }

      const shortName = modelId.split('/')[1] || modelId;
      let lastPct = -1;
      cachedGenerator = await transformers.pipeline('text-generation', modelId, {
        dtype,
        device,
        progress_callback: (info: { status?: string; progress?: number }) => {
          if (info.status === 'progress' && typeof info.progress === 'number') {
            const pct = Math.round(info.progress);
            if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
              lastPct = pct;
              self.postMessage({
                type: 'status',
                id,
                status: `Caching ${shortName} (${pct}%)...`,
              });
            }
          } else if (info.status === 'ready') {
            self.postMessage({ type: 'status', id, status: 'Generating summary...' });
          }
        },
      });
      cachedKey = targetKey;
    }

    self.postMessage({ type: 'status', id, status: 'Generating summary...' });

    let streamedText = '';
    const streamer =
      transformers.TextStreamer && cachedGenerator.tokenizer
        ? new transformers.TextStreamer(cachedGenerator.tokenizer, {
            skip_prompt: true,
            skip_special_tokens: true,
            callback_function: (tokenText: string) => {
              streamedText += tokenText;
              self.postMessage({ type: 'chunk', id, text: streamedText });
            },
          })
        : undefined;

    const output = await cachedGenerator(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      {
        max_new_tokens: 160,
        do_sample: false,
        ...(streamer ? { streamer } : {}),
      }
    );

    const generated = output?.[0]?.generated_text;
    const text = (
      Array.isArray(generated)
        ? String(generated[generated.length - 1]?.content ?? '')
        : String(generated ?? '')
    ).trim();

    if (!text) {
      throw new Error('In-browser AI returned an empty response.');
    }

    self.postMessage({
      type: 'done',
      id,
      summary: text,
      modelUsed: `browser/${modelId.split('/')[1]} (${device})`,
    });
  } catch (err: unknown) {
    self.postMessage({
      type: 'error',
      id,
      error: err instanceof Error ? err.message : 'In-browser AI worker failed.',
    });
  }
};
