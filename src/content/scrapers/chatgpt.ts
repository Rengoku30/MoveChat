import type { Message, AttachedFile } from '../../shared/types';
import { elementToMarkdown } from '../dom';

// Wait for an image element to complete loading
function waitForImageLoad(img: HTMLImageElement, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (img.complete) {
      resolve();
      return;
    }
    const onLoad = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); resolve(); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
    const cleanup = () => {
      img.removeEventListener('load', onLoad);
      img.removeEventListener('error', onError);
      clearTimeout(timer);
    };
    img.addEventListener('load', onLoad);
    img.addEventListener('error', onError);
  });
}

async function fetchWithTimeout(url: string, ms = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { signal: controller.signal, credentials: 'include' });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

// Convert an image to base64 using Canvas first, then background CORS proxy
async function imageToBase64(img: HTMLImageElement): Promise<string> {
  const src = img.getAttribute('src') || '';
  if (!src) return '';

  // Already base64
  if (src.startsWith('data:')) return src;

  // Skip tiny images (avatars/icons are typically <48px)
  if (img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalWidth < 48 && img.naturalHeight < 48) {
    return '';
  }

  // Wait until the image is loaded
  await waitForImageLoad(img);

  // 1. Try canvas (works for same-origin)
  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        if (dataUrl && dataUrl !== 'data:,' && dataUrl.length > 100) {
          return dataUrl;
        }
      }
    } catch (_) {
      // Tainted canvas — fall through
    }
  }

  // 2. Try direct fetch from content script (with timeout)
  try {
    const resp = await fetchWithTimeout(src);
    if (resp.ok) {
      const blob = await resp.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  } catch (_) {
    // Cross-origin blocked / timeout — fall through
  }

  // 3. Background CORS proxy (with timeout)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve('');
    }, 5000);
    chrome.runtime.sendMessage({ action: 'FETCH_IMAGE_BASE64', url: src }, (resp) => {
      clearTimeout(timer);
      resolve(resp?.base64 || '');
    });
  });
}

export const scrapeChatGPT = async (
  onProgress?: (current: number, total: number, step: string) => void
): Promise<any> => {
  onProgress?.(0, 1, 'Finding messages...');

  // Primary: use stable data-message-author-role attribute
  let messageContainers: Element[] = Array.from(document.querySelectorAll('[data-message-author-role]'));
  if (messageContainers.length === 0) {
    // Newer ChatGPT UI: <li data-message-role="user|assistant"> inside the transcript list
    messageContainers = Array.from(document.querySelectorAll('[data-message-role]'));
  }
  if (messageContainers.length === 0) {
    // Logged-in ChatGPT app shell: one unit per message, role at the end of the key ("turn-0:1:assistant")
    messageContainers = Array.from(document.querySelectorAll(
      '[data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"]'
    ));
  }
  if (messageContainers.length === 0) {
    // Fallback: try conversation-turn test IDs
    const turnContainers = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    if (turnContainers.length === 0) {
      throw new Error('No messages found. Are you in a chat session?');
    }
    // Within each turn, find the role-bearing child
    for (const turn of Array.from(turnContainers)) {
      const roleEl = turn.querySelector('[data-message-author-role]');
      if (roleEl) {
        messageContainers.push(roleEl);
      } else {
        messageContainers.push(turn);
      }
    }
  }

  onProgress?.(0, messageContainers.length, 'Loading images...');

  // Pre-load all images on the page before scraping
  const allPageImages = Array.from(document.querySelectorAll('img')) as HTMLImageElement[];
  await Promise.all(allPageImages.map(img => waitForImageLoad(img, 3000)));

  const messages: Message[] = [];
  let imageCount = 0;
  let fileCount = 0;

  for (let i = 0; i < messageContainers.length; i++) {
    const container = messageContainers[i];
    onProgress?.(i + 1, messageContainers.length, `Processing message ${i + 1}/${messageContainers.length}...`);

    // 1. Identify Role
    let role: 'user' | 'assistant' = 'user';
    const roleAttr = container.getAttribute('data-message-author-role') ||
                     container.getAttribute('data-message-role') ||
                     container.getAttribute('data-content-search-unit-key')?.split(':').pop();
    if (roleAttr === 'assistant') {
      role = 'assistant';
    } else if (!roleAttr && container.querySelector('.markdown, [data-assistant-markdown-root]')) {
      role = 'assistant';
    }

    // 2. Extract Text Content using HTML-to-Markdown
    const contentNode = container.querySelector('.markdown') ||
                        container.querySelector('[data-assistant-markdown-root]') ||
                        container.querySelector('[data-markdown-text-style="assistant-message"]') ||
                        container.querySelector('[data-markdown-text-tone="user-message"]') ||
                        container.querySelector('.whitespace-pre-wrap') ||
                        container.querySelector('[data-user-message-bubble]') ||
                        container;
    
    const text = elementToMarkdown(contentNode);

    // 3. Extract Files & Images
    const files: AttachedFile[] = [];
    const images = container.querySelectorAll('img');
    
    for (const img of Array.from(images)) {
      const src = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';
      
      const isAvatarOrProfile = 
        src.includes('profile') || 
        src.includes('avatar') || 
        src.includes('logo') ||
        alt.toLowerCase().includes('avatar') ||
        alt.toLowerCase().includes('profile') ||
        img.closest('[class*="avatar"]') !== null;

      if (isAvatarOrProfile) continue;

      if (src) {
        const base64 = await imageToBase64(img);
        if (base64 && base64.length > 100) {
          const isDup = files.some(f => f.content === base64);
          if (!isDup) {
            files.push({
              name: alt || `image-${imageCount + 1}.png`,
              type: 'image/png',
              content: base64
            });
            imageCount++;
          }
        }
      }
    }

    const filePills = container.querySelectorAll('a[download], [class*="file-pill"], [class*="attachment"]');
    for (const pill of Array.from(filePills)) {
      const fileName = pill.textContent || 'attachment';
      const cleanedName = fileName.trim();
      if (cleanedName && !files.some(f => f.name === cleanedName)) {
        files.push({
          name: cleanedName,
          type: 'application/octet-stream',
        });
        fileCount++;
      }
    }

    if (text.trim()) {
      messages.push({
        role,
        content: text.trim(),
        files: files.length > 0 ? files : undefined
      });
    }
  }

  let title = document.title || 'ChatGPT Handoff';
  if (title === 'ChatGPT' || title.trim() === '') {
    const firstUserMsg = messages.find(m => m.role === 'user');
    title = firstUserMsg ? firstUserMsg.content.substring(0, 40) + '...' : 'ChatGPT Handoff';
  }

  return {
    title,
    messages,
    messageCount: messages.length,
    imageCount,
    fileCount,
    savedAt: new Date().toISOString(),
    startedAt: new Date().toISOString()
  };
};
