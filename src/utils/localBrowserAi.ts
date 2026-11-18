import type { DiffStats } from '../types/diff';

export type LocalAiModelKey =
  | 'gemma3-270m'
  | 'lamini-t5-248m'
  | 'smollm2-360m'
  | 'smollm2-135m'
  | 'qwen3-0.6b';

export interface LocalAiModelSpec {
  key: LocalAiModelKey;
  label: string;
  badge: string;
  modelId: string;
  task: 'text-generation' | 'text2text-generation';
  wasmDtype: 'q4' | 'int8';
  webgpuDtype: 'q4' | 'q4f16' | 'int8';
  estimatedMb: number;
  preferWasm: boolean;
  cacheMatch: string;
  description: string;
}

export const LOCAL_AI_MODELS: LocalAiModelSpec[] = [
  {
    key: 'gemma3-270m',
    label: 'Gemma 3 270M',
    badge: 'Balanced',
    modelId: 'onnx-community/gemma-3-270m-it-ONNX',
    task: 'text-generation',
    wasmDtype: 'q4',
    webgpuDtype: 'q4',
    estimatedMb: 307,
    preferWasm: false,
    cacheMatch: 'gemma-3-270m',
    description: 'Google Gemma 3 compact instruct model for clear diff summaries.',
  },
  {
    key: 'lamini-t5-248m',
    label: 'LaMini-Flan-T5 248M',
    badge: 'Fast CPU',
    modelId: 'Xenova/LaMini-Flan-T5-248M',
    task: 'text2text-generation',
    wasmDtype: 'int8',
    webgpuDtype: 'int8',
    estimatedMb: 246,
    preferWasm: true,
    cacheMatch: 'LaMini-Flan-T5-248M',
    description: 'Encoder-decoder T5 model; fast single-pass encoding on CPU WASM.',
  },
  {
    key: 'smollm2-135m',
    label: 'SmolLM2 135M',
    badge: 'Lightest',
    modelId: 'onnx-community/SmolLM2-135M-Instruct-ONNX',
    task: 'text-generation',
    wasmDtype: 'q4',
    webgpuDtype: 'q4',
    estimatedMb: 172,
    preferWasm: false,
    cacheMatch: 'SmolLM2-135M',
    description: 'Smallest download (~172 MB) for quick summaries on low-memory devices.',
  },
  {
    key: 'smollm2-360m',
    label: 'SmolLM2 360M',
    badge: 'Compact',
    modelId: 'onnx-community/SmolLM2-360M-Instruct-ONNX',
    task: 'text-generation',
    wasmDtype: 'q4',
    webgpuDtype: 'q4',
    estimatedMb: 368,
    preferWasm: false,
    cacheMatch: 'SmolLM2-360M',
    description: 'Stronger SmolLM2 variant for multi-hunk explanations.',
  },
  {
    key: 'qwen3-0.6b',
    label: 'Qwen3 0.6B',
    badge: 'Best Code',
    modelId: 'onnx-community/Qwen3-0.6B-ONNX',
    task: 'text-generation',
    wasmDtype: 'int8',
    webgpuDtype: 'q4f16',
    estimatedMb: 590,
    preferWasm: false,
    cacheMatch: 'Qwen3-0.6B',
    description: 'Best local code reasoning (recommended with WebGPU).',
  },
];

export function getLocalAiModelSpec(key: LocalAiModelKey): LocalAiModelSpec {
  return LOCAL_AI_MODELS.find((m) => m.key === key) ?? LOCAL_AI_MODELS[0];
}

export interface DeviceCapabilities {
  deviceMemoryGb: number | null;
  cpuCores: number | null;
  hasWebGpu: boolean;
  hasShaderF16: boolean;
  gpuLabel: string | null;
  freeStorageMb: number | null;
  saveData: boolean;
  effectiveConnection: string | null;
  isCached: boolean;
  isLowEnd: boolean;
  warnings: string[];
  modelId: string;
  modelLabel: string;
  estimatedDownloadMb: number;
}

let aiWorker: Worker | null = null;
let aiRequestSeq = 0;

function getAiWorker(): Worker {
  if (!aiWorker) {
    aiWorker = new Worker(new URL('../workers/localAi.worker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return aiWorker;
}

export async function clearLocalAiCache(): Promise<boolean> {
  if (aiWorker) {
    aiWorker.postMessage({ type: 'clear' });
  }
  if (typeof caches === 'undefined') return false;
  try {
    return await caches.delete('transformers-cache');
  } catch {
    return false;
  }
}

export function compactDiffForLocalAi(
  hunksPatch: string,
  maxChars = 1600
): { compacted: string; totalHunks: number; sampledHunks: number } {
  const blocks = hunksPatch
    .split(/(?=^@@ )/m)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return { compacted: hunksPatch.slice(0, maxChars), totalHunks: 0, sampledHunks: 0 };
  }

  const compactBlock = (block: string, perHunkBudget: number): string => {
    const lines = block.split('\n');
    const out: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-')) {
        const clipped = line.length > 160 ? `${line.slice(0, 157)}...` : line;
        if (used + clipped.length + 1 > perHunkBudget) {
          out.push('... (hunk truncated)');
          break;
        }
        out.push(clipped);
        used += clipped.length + 1;
      }
    }
    return out.join('\n');
  };

  if (blocks.length <= 6) {
    const perHunk = Math.max(240, Math.floor(maxChars / blocks.length));
    const joined = blocks.map((b) => compactBlock(b, perHunk)).join('\n');
    return {
      compacted: joined.slice(0, maxChars),
      totalHunks: blocks.length,
      sampledHunks: blocks.length,
    };
  }

  const sampleCount = Math.min(8, blocks.length);
  const perHunk = Math.max(160, Math.floor(maxChars / sampleCount));
  const picked: string[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.min(
      blocks.length - 1,
      Math.round((i * (blocks.length - 1)) / (sampleCount - 1))
    );
    picked.push(compactBlock(blocks[idx], perHunk));
  }

  const headerNote = `[Sampled ${sampleCount} of ${blocks.length} hunks across diff]\n`;
  return {
    compacted: (headerNote + picked.join('\n')).slice(0, maxChars),
    totalHunks: blocks.length,
    sampledHunks: sampleCount,
  };
}

const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:public|private|protected|static|final|synchronized|\s)*[\w<>[\]]+\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_][\w]*)\s*\(/,
  /^\s*"([A-Za-z0-9_.-]+)"\s*:/,
];

const RISK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(catch|try|throw|throws|panic|unwrap|except)\b/i, label: 'error-handling paths' },
  { pattern: /\b(auth|token|password|secret|api_?key|jwt|session|cors)\b/i, label: 'auth/credential logic' },
  { pattern: /\b(async|await|Promise|Worker|mutex|lock|synchronized|atomic)\b/i, label: 'concurrency/async flow' },
  { pattern: /\b(if|else|switch|case|return|break|continue)\b/, label: 'control-flow branches' },
  { pattern: /\b(fetch|axios|sql|query|delete|drop|exec)\b/i, label: 'network/data mutations' },
  { pattern: /\b(TODO|FIXME|HACK|XXX)\b/, label: 'TODO/FIXME markers' },
];

export function generateInstantLocalSummary(params: {
  hunksPatch: string;
  stats: DiffStats;
  focus: 'concise' | 'detailed' | 'risks';
  title: string;
  language: string;
}): { summary: string; modelUsed: string; chunkCount: number } {
  const { hunksPatch, stats, focus, title, language } = params;
  const blocks = hunksPatch
    .split(/(?=^@@ )/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const addedSymbols = new Set<string>();
  const removedSymbols = new Set<string>();
  const importEdits: string[] = [];
  const riskSignals = new Map<string, number>();
  const hunkHighlights: Array<{ header: string; adds: number; removes: number; sample: string }> = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    const headerMatch = lines[0]?.match(/^@@\s+(-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?)\s+@@/);
    const header = headerMatch ? headerMatch[1] : 'hunk';
    let adds = 0;
    let removes = 0;
    let sample = '';

    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      const isAdd = raw.startsWith('+');
      const isDel = raw.startsWith('-');
      if (!isAdd && !isDel) continue;

      const body = raw.slice(1);
      const trimmed = body.trim();
      if (isAdd) adds++;
      else removes++;

      if (!sample && trimmed.length > 0) {
        sample = trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed;
      }

      if (/^(import|from|using|#include|use)\b/.test(trimmed) && importEdits.length < 6) {
        importEdits.push(`${isAdd ? '+' : '-'} ${trimmed.slice(0, 72)}`);
      }

      for (const rx of SYMBOL_PATTERNS) {
        const m = body.match(rx);
        if (m?.[1]) {
          if (isAdd) addedSymbols.add(m[1]);
          else removedSymbols.add(m[1]);
          break;
        }
      }

      for (const risk of RISK_PATTERNS) {
        if (risk.pattern.test(trimmed)) {
          riskSignals.set(risk.label, (riskSignals.get(risk.label) ?? 0) + 1);
        }
      }
    }

    if (hunkHighlights.length < 10) {
      hunkHighlights.push({ header, adds, removes, sample });
    }
  }

  const modifiedSymbols = [...addedSymbols].filter((s) => removedSymbols.has(s));
  const netDelta = stats.added - stats.removed;
  const deltaStr = netDelta >= 0 ? `+${netDelta}` : `${netDelta}`;

  const out: string[] = [];
  out.push(`### Overview (${title || 'Untitled diff'} · ${language})`);
  out.push(
    `- **Scope**: \`+${stats.added.toLocaleString()}\` added, \`-${stats.removed.toLocaleString()}\` removed (net \`${deltaStr}\` lines) across **${stats.hunkCount.toLocaleString()}** hunk(s).`
  );

  if (modifiedSymbols.length > 0) {
    out.push(
      `- **Modified symbols**: ${modifiedSymbols
        .slice(0, 8)
        .map((s) => `\`${s}\``)
        .join(', ')}${modifiedSymbols.length > 8 ? ` (+${modifiedSymbols.length - 8} more)` : ''}.`
    );
  }
  const pureAdded = [...addedSymbols].filter((s) => !removedSymbols.has(s));
  if (pureAdded.length > 0) {
    out.push(
      `- **Added symbols**: ${pureAdded
        .slice(0, 8)
        .map((s) => `\`${s}\``)
        .join(', ')}${pureAdded.length > 8 ? ` (+${pureAdded.length - 8} more)` : ''}.`
    );
  }
  const pureRemoved = [...removedSymbols].filter((s) => !addedSymbols.has(s));
  if (pureRemoved.length > 0) {
    out.push(
      `- **Removed symbols**: ${pureRemoved
        .slice(0, 8)
        .map((s) => `\`${s}\``)
        .join(', ')}${pureRemoved.length > 8 ? ` (+${pureRemoved.length - 8} more)` : ''}.`
    );
  }
  if (importEdits.length > 0) {
    out.push(`- **Dependency/import edits**: ${importEdits.length} line(s) updated.`);
  }

  if (focus === 'risks' || riskSignals.size > 0) {
    out.push('');
    out.push('### Risk Signals');
    if (riskSignals.size === 0) {
      out.push('- No high-risk control-flow, auth, or error-handling mutations detected in changed lines.');
    } else {
      for (const [label, count] of [...riskSignals.entries()].sort((a, b) => b[1] - a[1])) {
        out.push(`- **${label}**: touched in \`${count}\` changed line(s).`);
      }
    }
    if (stats.removed > stats.added * 2 && stats.removed > 25) {
      out.push(`- **Large deletion**: \`-${stats.removed}\` lines removed; verify no callers or fallback paths were dropped.`);
    }
  }

  if (focus === 'detailed' && hunkHighlights.length > 0) {
    out.push('');
    out.push(`### Hunk Breakdown${blocks.length > hunkHighlights.length ? ` (first ${hunkHighlights.length} of ${blocks.length})` : ''}`);
    for (const h of hunkHighlights) {
      out.push(
        `- \`@@ ${h.header} @@\` (\`+${h.adds}\` / \`-${h.removes}\`)${h.sample ? ` — \`${h.sample.replace(/`/g, "'")}\`` : ''}`
      );
    }
  }

  return {
    summary: out.join('\n'),
    modelUsed: 'local/instant-analyzer (0ms)',
    chunkCount: Math.max(1, blocks.length),
  };
}

export async function inspectDeviceCapabilities(
  modelKey: LocalAiModelKey = 'gemma3-270m'
): Promise<DeviceCapabilities> {
  const spec = getLocalAiModelSpec(modelKey);
  const nav = navigator as unknown as {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    gpu?: {
      requestAdapter?: () => Promise<{
        features?: { has?: (name: string) => boolean };
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
  let hasShaderF16 = false;
  let gpuLabel: string | null = null;
  try {
    if (nav.gpu?.requestAdapter) {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) {
        hasWebGpu = true;
        hasShaderF16 = Boolean(adapter.features?.has?.('shader-f16'));
        const info = adapter.info;
        const parts = [info?.vendor, info?.description || info?.architecture].filter(Boolean);
        gpuLabel = parts.length > 0 ? parts.join(' ') : 'WebGPU GPU adapter';
      }
    }
  } catch {
    hasWebGpu = false;
  }

  const useWebGpu = hasWebGpu && !spec.preferWasm;
  const estimatedDownloadMb = spec.estimatedMb;

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

  let isCached = false;
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      isCached = keys.some(
        (req) => req.url.includes(spec.cacheMatch) && req.url.includes('.onnx')
      );
    } catch {
      isCached = false;
    }
  }

  const warnings: string[] = [];
  if (deviceMemoryGb !== null && deviceMemoryGb <= 2) {
    warnings.push(`Limited system memory (${deviceMemoryGb} GB reported).`);
  }
  if (cpuCores !== null && cpuCores < 4 && !useWebGpu) {
    warnings.push(`Low CPU core count (${cpuCores} cores) without GPU acceleration.`);
  }
  if (!useWebGpu && !spec.preferWasm) {
    warnings.push('WebGPU unavailable — running in Web Worker CPU WASM (auto-fallback).');
  }
  if (!isCached && freeStorageMb !== null && freeStorageMb < estimatedDownloadMb + 120) {
    warnings.push(`Low browser cache quota (~${freeStorageMb} MB free; ~${estimatedDownloadMb} MB required).`);
  }
  if (
    !isCached &&
    (saveData ||
      effectiveConnection === 'slow-2g' ||
      effectiveConnection === '2g' ||
      effectiveConnection === '3g')
  ) {
    warnings.push(
      `Slow or metered network (${effectiveConnection || 'Data Saver'}) for a ~${estimatedDownloadMb} MB download.`
    );
  }

  return {
    deviceMemoryGb,
    cpuCores,
    hasWebGpu: useWebGpu,
    hasShaderF16,
    gpuLabel,
    freeStorageMb,
    saveData,
    effectiveConnection,
    isCached,
    isLowEnd: warnings.length > 0,
    warnings,
    modelId: spec.modelId,
    modelLabel: `${spec.label} (${useWebGpu ? 'WebGPU' : 'WASM'})`,
    estimatedDownloadMb,
  };
}

export async function runInBrowserLocalAI(
  hunksPatch: string,
  focus: 'concise' | 'detailed' | 'risks',
  title: string,
  language: string,
  modelKey: LocalAiModelKey = 'gemma3-270m',
  onProgress?: (statusText: string) => void,
  onStreamChunk?: (partialText: string) => void
): Promise<{ summary: string; modelUsed: string }> {
  const spec = getLocalAiModelSpec(modelKey);
  const caps = await inspectDeviceCapabilities(modelKey);
  const device: 'webgpu' | 'wasm' = caps.hasWebGpu ? 'webgpu' : 'wasm';
  let dtype: 'q4' | 'q4f16' | 'int8' = device === 'webgpu' ? spec.webgpuDtype : spec.wasmDtype;
  if (dtype === 'q4f16' && !caps.hasShaderF16) {
    dtype = 'q4';
  }

  const { compacted } = compactDiffForLocalAi(hunksPatch, 1600);

  const focusDirective =
    focus === 'risks'
      ? 'List potential bugs, edge cases, or regressions in short bullets.'
      : focus === 'detailed'
      ? 'Explain the key changes in short technical bullets.'
      : 'Summarize the main changes in 3-5 short bullet points.';

  const systemPrompt = `You are a senior engineer reviewing a code diff. ${focusDirective} Cite exact symbol names.`;
  const thinkSuffix = modelKey === 'qwen3-0.6b' ? '\n/no_think' : '';
  const prompt = `Title: ${title || 'Untitled'}\nLanguage: ${language}\n\n${compacted}${thinkSuffix}`;

  const worker = getAiWorker();
  const requestId = ++aiRequestSeq;

  return new Promise((resolve, reject) => {
    const onMessage = (
      event: MessageEvent<{
        type: 'status' | 'chunk' | 'done' | 'error';
        id: number;
        status?: string;
        text?: string;
        summary?: string;
        modelUsed?: string;
        error?: string;
      }>
    ) => {
      const data = event.data;
      if (!data || data.id !== requestId) return;

      if (data.type === 'status' && data.status) {
        onProgress?.(data.status);
      } else if (data.type === 'chunk' && typeof data.text === 'string') {
        onStreamChunk?.(data.text);
      } else if (data.type === 'done' && data.summary && data.modelUsed) {
        cleanup();
        resolve({ summary: data.summary, modelUsed: data.modelUsed });
      } else if (data.type === 'error') {
        cleanup();
        reject(new Error(data.error || 'In-browser AI failed.'));
      }
    };

    const onError = (err: ErrorEvent) => {
      cleanup();
      reject(new Error(err.message || 'In-browser AI worker crashed.'));
    };

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);

    worker.postMessage({
      type: 'run',
      id: requestId,
      task: spec.task,
      prompt,
      systemPrompt,
      modelId: spec.modelId,
      device,
      dtype,
    });
  });
}
