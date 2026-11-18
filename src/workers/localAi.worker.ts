interface PipelineInstance {
  (
    input: string | Array<{ role: string; content: string }>,
    options: Record<string, unknown>
  ): Promise<Array<{ generated_text?: Array<{ role?: string; content?: string }> | string }>>;
  tokenizer?: unknown;
}

interface WorkerRunRequest {
  type: 'run';
  id: number;
  task: 'text-generation' | 'text2text-generation';
  prompt: string;
  systemPrompt: string;
  modelId: string;
  device: 'webgpu' | 'wasm';
  dtype: 'q4' | 'q4f16' | 'int8';
}

interface WorkerClearRequest {
  type: 'clear';
}

type WorkerRequest = WorkerRunRequest | WorkerClearRequest;

const TRANSFORMERS_VER = '4.3.2';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VER}/dist/`;
const CDN_ENTRY = `${CDN_BASE}transformers.min.js`;

let cachedGenerator: PipelineInstance | null = null;
let cachedKey: string | null = null;

function formatWorkerError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  if (typeof err === 'string' && err.trim()) {
    return err.trim();
  }
  if (typeof err === 'number') {
    return `ONNX Runtime error code ${err}`;
  }
  if (err && typeof err === 'object') {
    const maybeMsg = (err as { message?: unknown }).message;
    if (typeof maybeMsg === 'string' && maybeMsg.trim()) {
      return maybeMsg.trim();
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      // Ignore stringify errors
    }
  }
  return 'Unknown worker initialization error';
}

async function loadPipeline(
  transformers: {
    pipeline: (
      task: string,
      model: string,
      opts: Record<string, unknown>
    ) => Promise<PipelineInstance>;
  },
  task: 'text-generation' | 'text2text-generation',
  modelId: string,
  device: 'webgpu' | 'wasm',
  dtype: 'q4' | 'q4f16' | 'int8',
  id: number
): Promise<PipelineInstance> {
  const shortName = modelId.split('/')[1] || modelId;
  let lastPct = -1;

  return transformers.pipeline(task, modelId, {
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
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === 'clear') {
    cachedGenerator = null;
    cachedKey = null;
    self.postMessage({ type: 'cleared' });
    return;
  }

  const { id, task, prompt, systemPrompt, modelId } = msg;
  let activeDevice = msg.device;
  let activeDtype = msg.dtype;

  try {
    const transformers = (await import(/* @vite-ignore */ CDN_ENTRY)) as {
      pipeline: (
        task: string,
        model: string,
        opts: Record<string, unknown>
      ) => Promise<PipelineInstance>;
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
        backends?: {
          onnx?: {
            wasm?: {
              wasmPaths?: string;
              proxy?: boolean;
              numThreads?: number;
            };
          };
        };
      };
    };

    if (transformers.env) {
      transformers.env.allowLocalModels = false;
      transformers.env.allowRemoteModels = true;
      transformers.env.useBrowserCache = true;
      if (transformers.env.backends?.onnx?.wasm) {
        transformers.env.backends.onnx.wasm.wasmPaths = CDN_BASE;
        transformers.env.backends.onnx.wasm.proxy = false;
        transformers.env.backends.onnx.wasm.numThreads =
          typeof self !== 'undefined' &&
          (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated
            ? Math.min(4, navigator.hardwareConcurrency || 2)
            : 1;
      }
    }

    const targetKey = `${modelId}:${activeDevice}:${activeDtype}`;
    if (!cachedGenerator || cachedKey !== targetKey) {
      const shortName = modelId.split('/')[1] || modelId;
      self.postMessage({
        type: 'status',
        id,
        status: `Loading ${shortName} (${activeDevice})...`,
      });

      try {
        cachedGenerator = await loadPipeline(
          transformers,
          task,
          modelId,
          activeDevice,
          activeDtype,
          id
        );
        cachedKey = targetKey;
      } catch (primaryErr) {
        if (activeDevice === 'webgpu') {
          activeDevice = 'wasm';
          activeDtype = task === 'text2text-generation' ? 'int8' : 'q4';
          self.postMessage({
            type: 'status',
            id,
            status: `WebGPU unavailable (${formatWorkerError(primaryErr)}); switching to CPU WASM...`,
          });
          cachedGenerator = await loadPipeline(
            transformers,
            task,
            modelId,
            activeDevice,
            activeDtype,
            id
          );
          cachedKey = `${modelId}:${activeDevice}:${activeDtype}`;
        } else {
          throw primaryErr;
        }
      }
    }

    self.postMessage({ type: 'status', id, status: 'Generating summary...' });

    let streamedText = '';
    let streamer: unknown;
    try {
      if (transformers.TextStreamer && cachedGenerator.tokenizer) {
        streamer = new transformers.TextStreamer(cachedGenerator.tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (tokenText: string) => {
            streamedText += tokenText;
            const cleaned = streamedText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            if (cleaned) {
              self.postMessage({ type: 'chunk', id, text: cleaned });
            }
          },
        });
      }
    } catch {
      streamer = undefined;
    }

    const modelInput =
      task === 'text2text-generation'
        ? `${systemPrompt}\n\n${prompt}`
        : [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ];

    const genOptions: Record<string, unknown> = {
      max_new_tokens: 160,
      do_sample: false,
      ...(task === 'text-generation' ? { return_full_text: false } : {}),
      ...(streamer ? { streamer } : {}),
    };

    const output = await cachedGenerator(modelInput, genOptions);
    const generated = output?.[0]?.generated_text;
    let text = (
      Array.isArray(generated)
        ? String(generated[generated.length - 1]?.content ?? '')
        : String(generated ?? '')
    ).trim();

    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    if (!text) {
      throw new Error('In-browser AI returned an empty response.');
    }

    self.postMessage({
      type: 'done',
      id,
      summary: text,
      modelUsed: `browser/${modelId.split('/')[1]} (${activeDevice})`,
    });
  } catch (err: unknown) {
    self.postMessage({
      type: 'error',
      id,
      error: formatWorkerError(err),
    });
  }
};
