import type { DiffStats } from '../types/diff';

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
  modelId: string;
  modelLabel: string;
  estimatedDownloadMb: number;
}

const MODEL_WASM = 'onnx-community/SmolLM2-135M-Instruct-ONNX';
const MODEL_WEBGPU = 'onnx-community/SmolLM2-360M-Instruct-ONNX';

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

  const modelId = hasWebGpu ? MODEL_WEBGPU : MODEL_WASM;
  const modelLabel = hasWebGpu ? 'SmolLM2-360M (WebGPU)' : 'SmolLM2-135M (CPU WASM)';
  const estimatedDownloadMb = hasWebGpu ? 220 : 95;

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
      const targetName = hasWebGpu ? 'SmolLM2-360M' : 'SmolLM2-135M';
      isCached = keys.some(
        (req) => req.url.includes(targetName) && req.url.includes('.onnx')
      );
    } catch {
      isCached = false;
    }
  }

  const warnings: string[] = [];
  if (deviceMemoryGb !== null && deviceMemoryGb <= 2) {
    warnings.push(`Limited system memory (${deviceMemoryGb} GB reported).`);
  }
  if (cpuCores !== null && cpuCores < 4 && !hasWebGpu) {
    warnings.push(`Low CPU core count (${cpuCores} cores) without GPU acceleration.`);
  }
  if (!hasWebGpu) {
    warnings.push('WebGPU unavailable — running lighter SmolLM2-135M via Web Worker WASM.');
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
    hasWebGpu,
    gpuLabel,
    freeStorageMb,
    saveData,
    effectiveConnection,
    isCached,
    isLowEnd: warnings.length > 0,
    warnings,
    modelId,
    modelLabel,
    estimatedDownloadMb,
  };
}

export async function runInBrowserLocalAI(
  hunksPatch: string,
  focus: 'concise' | 'detailed' | 'risks',
  title: string,
  language: string,
  onProgress?: (statusText: string) => void,
  onStreamChunk?: (partialText: string) => void
): Promise<{ summary: string; modelUsed: string }> {
  const caps = await inspectDeviceCapabilities();
  const device: 'webgpu' | 'wasm' = caps.hasWebGpu ? 'webgpu' : 'wasm';
  const dtype: 'q4' | 'q4f16' = caps.hasWebGpu ? 'q4f16' : 'q4';

  const { compacted } = compactDiffForLocalAi(hunksPatch, 1600);

  const focusDirective =
    focus === 'risks'
      ? 'List potential bugs, edge cases, or regressions in short bullets.'
      : focus === 'detailed'
      ? 'Explain the key changes in short technical bullets.'
      : 'Summarize the main changes in 3-5 short bullet points.';

  const systemPrompt = `You are a senior engineer reviewing a code diff. ${focusDirective} Cite exact symbol names.`;
  const prompt = `Title: ${title || 'Untitled'}\nLanguage: ${language}\n\n${compacted}`;

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
      prompt,
      systemPrompt,
      modelId: caps.modelId,
      device,
      dtype,
    });
  });
}
