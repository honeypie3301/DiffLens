interface TextGenPipeline {
  (
    messages: Array<{ role: string; content: string }>,
    options: { max_new_tokens: number; do_sample: boolean; temperature?: number }
  ): Promise<Array<{ generated_text?: Array<{ role?: string; content?: string }> | string }>>;
}

export interface DeviceCapabilities {
  deviceMemoryGb: number | null;
  cpuCores: number | null;
  hasWebGpu: boolean;
  gpuLabel: string | null;
  freeStorageMb: number | null;
  saveData: boolean;
  effectiveConnection: string | null;
  isCached: boolean;
  isLowEnd: boolean;
  warnings: string[];
}

let cachedGenerator: TextGenPipeline | null = null;
let cachedDevice: 'webgpu' | 'wasm' = 'wasm';

const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';
const CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/+esm';

export async function clearLocalAiCache(): Promise<boolean> {
  cachedGenerator = null;
  if (typeof caches === 'undefined') return false;
  try {
    return await caches.delete('transformers-cache');
  } catch {
    return false;
  }
}

export async function inspectDeviceCapabilities(): Promise<DeviceCapabilities> {
  const nav = navigator as unknown as {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    gpu?: {
      requestAdapter?: () => Promise<{
        info?: { description?: string; vendor?: string; architecture?: string };
      } | null>;
    };
    storage?: {
      estimate?: () => Promise<{ quota?: number; usage?: number }>;
    };
    connection?: {
      saveData?: boolean;
      effectiveType?: string;
    };
  };

  const deviceMemoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  const cpuCores = typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
  const saveData = Boolean(nav.connection?.saveData);
  const effectiveConnection = nav.connection?.effectiveType ?? null;

  let hasWebGpu = false;
  let gpuLabel: string | null = null;
  try {
    if (nav.gpu?.requestAdapter) {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) {
        hasWebGpu = true;
        const info = adapter.info;
        const parts = [info?.vendor, info?.description || info?.architecture].filter(Boolean);
        gpuLabel = parts.length > 0 ? parts.join(' ') : 'WebGPU GPU adapter';
      }
    }
  } catch {
    hasWebGpu = false;
  }

  let freeStorageMb: number | null = null;
  try {
    if (nav.storage?.estimate) {
      const est = await nav.storage.estimate();
      if (typeof est.quota === 'number') {
        const used = typeof est.usage === 'number' ? est.usage : 0;
        freeStorageMb = Math.max(0, Math.round((est.quota - used) / (1024 * 1024)));
      }
    }
  } catch {
    freeStorageMb = null;
  }

  let isCached = Boolean(cachedGenerator);
  if (!isCached && typeof caches !== 'undefined') {
    try {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      isCached = keys.some(
        (req) => req.url.includes('Qwen2.5-0.5B-Instruct') && req.url.includes('.onnx')
      );
    } catch {
      isCached = false;
    }
  }

  const warnings: string[] = [];
  if (deviceMemoryGb !== null && deviceMemoryGb <= 4) {
    warnings.push(`Limited system memory (${deviceMemoryGb} GB reported; model uses ~600 MB–1 GB).`);
  }
  if (cpuCores !== null && cpuCores < 4 && !hasWebGpu) {
    warnings.push(`Low CPU core count (${cpuCores} cores) without GPU acceleration.`);
  }
  if (!hasWebGpu) {
    warnings.push('WebGPU unavailable — will fall back to slower CPU WebAssembly inference.');
  }
  if (!isCached && freeStorageMb !== null && freeStorageMb < 750) {
    warnings.push(`Low browser cache quota (~${freeStorageMb} MB free; ~420 MB required).`);
  }
  if (
    !isCached &&
    (saveData ||
      effectiveConnection === 'slow-2g' ||
      effectiveConnection === '2g' ||
      effectiveConnection === '3g')
  ) {
    warnings.push(
      `Slow or metered network (${effectiveConnection || 'Data Saver'}) for a ~390 MB initial download.`
    );
  }

  return {
    deviceMemoryGb,
    cpuCores,
    hasWebGpu,
    gpuLabel,
    freeStorageMb,
    saveData,
    effectiveConnection,
    isCached,
    isLowEnd: warnings.length > 0,
    warnings,
  };
}

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
      env?: {
        allowLocalModels?: boolean;
        allowRemoteModels?: boolean;
        useBrowserCache?: boolean;
        backends?: { onnx?: { wasm?: { numThreads?: number } } };
      };
    };

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
