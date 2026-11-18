function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  const activeEl = document.activeElement as HTMLElement | null;
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
    activeEl?.focus?.({ preventScroll: true });
  }
  return copied;
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  const inIframe = typeof window !== 'undefined' && window.self !== window.top;
  if (inIframe && execCommandCopy(text)) {
    return true;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Blocked in sandboxed iframes or insecure contexts; fall back to execCommand.
    }
  }

  return execCommandCopy(text);
}
