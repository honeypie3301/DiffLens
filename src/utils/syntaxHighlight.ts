import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diffLang from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

hljs.registerLanguage('java', java);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('diff', diffLang);

export const SUPPORTED_LANGUAGES = [
  { id: 'auto', label: 'Auto Detect' },
  { id: 'plaintext', label: 'Plain Text' },
  { id: 'java', label: 'Java' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'cpp', label: 'C++' },
  { id: 'c', label: 'C' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'json', label: 'JSON' },
  { id: 'xml', label: 'HTML / XML' },
  { id: 'css', label: 'CSS' },
  { id: 'sql', label: 'SQL' },
  { id: 'yaml', label: 'YAML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'bash', label: 'Shell / Bash' },
  { id: 'diff', label: 'Patch / Diff' },
] as const;

export interface TokenRun {
  text: string;
  className: string;
}

const CACHE_LIMIT = 12000;
const tokenCache = new Map<string, TokenRun[]>();

function decodeEntities(str: string): string {
  if (!str.includes('&')) return str;
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseHljsHtmlToRuns(html: string): TokenRun[] {
  if (!html) return [];
  if (!html.includes('<')) {
    return [{ text: decodeEntities(html), className: '' }];
  }

  const runs: TokenRun[] = [];
  const stack: string[] = [];
  const tagRegex = /<\/?span(?:\s+class="([^"]*)")?>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const rawText = decodeEntities(html.slice(lastIndex, match.index));
      if (rawText) {
        runs.push({ text: rawText, className: stack[stack.length - 1] ?? '' });
      }
    }
    if (match[0].startsWith('</')) {
      stack.pop();
    } else {
      stack.push(match[1] ?? '');
    }
    lastIndex = tagRegex.lastIndex;
  }

  if (lastIndex < html.length) {
    const tail = decodeEntities(html.slice(lastIndex));
    if (tail) {
      runs.push({ text: tail, className: stack[stack.length - 1] ?? '' });
    }
  }

  return runs;
}

export function detectLanguage(sample: string): string {
  const trimmed = sample.slice(0, 6000).trim();
  if (!trimmed) return 'plaintext';

  if (/^\s*[\{\[]/.test(trimmed) && (trimmed.includes('":') || trimmed.includes('": '))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Fall through
    }
  }
  if (/\b(private|public|protected)\s+(static\s+)?(boolean|void|int|double|class|record)\b/.test(trimmed)) {
    return 'java';
  }
  if (/\b(interface|type)\s+[A-Z]\w*\s*(=|\{)/.test(trimmed) || /:\s*(string|number|boolean|Promise<)/.test(trimmed)) {
    return 'typescript';
  }
  if (/\bdef\s+\w+\(.*\)\s*(->.*)?:/m.test(trimmed) || /\bimport\s+\w+\s+as\s+\w+/m.test(trimmed)) {
    return 'python';
  }
  if (/^#!\/bin\/(bash|sh|zsh)/m.test(trimmed)) {
    return 'bash';
  }

  try {
    const res = hljs.highlightAuto(trimmed, [
      'java',
      'typescript',
      'javascript',
      'python',
      'json',
      'cpp',
      'go',
      'rust',
      'xml',
      'css',
      'sql',
      'yaml',
      'bash',
      'kotlin',
    ]);
    return res.language || 'plaintext';
  } catch {
    return 'plaintext';
  }
}

export function highlightLineTokens(line: string, language: string): TokenRun[] {
  if (!line) return [];
  if (language === 'plaintext' || line.length > 2500) {
    return [{ text: line, className: '' }];
  }

  const key = `${language}\0${line}`;
  const cached = tokenCache.get(key);
  if (cached !== undefined) {
    tokenCache.delete(key);
    tokenCache.set(key, cached);
    return cached;
  }

  let runs: TokenRun[];
  try {
    const html = hljs.highlight(line, { language, ignoreIllegals: true }).value;
    runs = parseHljsHtmlToRuns(html);
  } catch {
    runs = [{ text: line, className: '' }];
  }

  if (tokenCache.size >= CACHE_LIMIT) {
    const firstKey = tokenCache.keys().next().value;
    if (firstKey !== undefined) {
      tokenCache.delete(firstKey);
    }
  }
  tokenCache.set(key, runs);
  return runs;
}
