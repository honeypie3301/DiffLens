interface TextGenPipeline {
  (
    messages: Array<{ role: string; content: string }>,
    options: { max_new_tokens: number; do_sample: boolean; temperature?: number }
  ): Promise<Array<{ generated_text?: Array<{ role?: string; content?: string }> | string }>>;
}

let cachedGenerator: TextGenPipeline | null = null;
let cachedDevice: 'webgpu' | 'wasm' = 'wasm';

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
const CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';

export async function runInBrowserLocalAI(
  hunksPatch: string,
  focus: 'concise' | 'detailed' | 'risks',
  title: string,
  language: string,
  onProgress?: (statusText: string) => void
): Promise<{ summary: string; modelUsed: string }> {
  if (!cachedGenerator) {
    onProgress?.('Loading in-browser AI runtime...');
    const transformers = (await import(/* @vite-ignore */ CDN_URL)) as {
      pipeline: (
        task: string,
        model: string,
        opts: Record<string, unknown>
      ) => Promise<TextGenPipeline>;
      env?: { allowLocalModels?: boolean };
    };

    if (transformers.env) {
      transformers.env.allowLocalModels = false;
    }

    let useWebGpu = false;
    try {
      const navGpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } })
        .gpu;
      if (navGpu?.requestAdapter) {
        useWebGpu = Boolean(await navGpu.requestAdapter());
      }
    } catch {
      useWebGpu = false;
    }

    cachedDevice = useWebGpu ? 'webgpu' : 'wasm';
    cachedGenerator = await transformers.pipeline('text-generation', MODEL_ID, {
      dtype: 'q4',
      device: cachedDevice,
      progress_callback: (info: { status?: string; progress?: number }) => {
        if (info.status === 'progress' && typeof info.progress === 'number') {
          onProgress?.(`Caching ${MODEL_ID.split('/')[1]} (${Math.round(info.progress)}%)...`);
        } else if (info.status === 'ready') {
          onProgress?.('Generating summary...');
        }
      },
    });
  }

  onProgress?.('Generating summary...');

  const focusDirective =
    focus === 'risks'
      ? 'Focus on potential bugs, edge cases, and regressions.'
      : focus === 'detailed'
      ? 'Provide a clear technical breakdown by change.'
      : 'Summarize concisely in 3-5 short bullet points.';

  const patchSnippet = hunksPatch.slice(0, 4800);
  const messages = [
    {
      role: 'system',
      content: `You are a senior software engineer reviewing a diff. ${focusDirective} Cite exact symbols when present.`,
    },
    {
      role: 'user',
      content: `Title: ${title || 'Untitled'}\nLanguage: ${language}\n\nDiff:\n${patchSnippet}`,
    },
  ];

  const output = await cachedGenerator(messages, {
    max_new_tokens: 300,
    do_sample: false,
  });

  const generated = output?.[0]?.generated_text;
  const text = Array.isArray(generated)
    ? String(generated[generated.length - 1]?.content ?? '').trim()
    : String(generated ?? '').trim();

  if (!text) {
    throw new Error('In-browser AI returned an empty response.');
  }

  return {
    summary: text,
    modelUsed: `browser/${MODEL_ID.split('/')[1]} (${cachedDevice})`,
  };
}
