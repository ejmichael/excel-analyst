import type { UploadRequest } from './client';

/**
 * XMLHttpRequest wrapped as a fetch-like call: plain fetch has no upload progress events.
 * Resolves with a Response for any HTTP status; rejects with a TypeError on network failure and an
 * AbortError when the signal fires, matching fetch so apiUpload can treat both the same way.
 */
export function xhrUpload(url: string, { form, headers, onProgress, signal }: UploadRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The upload was cancelled.', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    });
    xhr.addEventListener('load', () => {
      const responseHeaders = new Headers();
      const retryAfter = xhr.getResponseHeader('Retry-After');
      if (retryAfter) responseHeaders.set('Retry-After', retryAfter);
      // A Response cannot carry status 0; a real HTTP status is always 100-599 here.
      resolve(new Response(xhr.responseText || null, { status: xhr.status, headers: responseHeaders }));
    });
    xhr.addEventListener('error', () => reject(new TypeError('Network request failed')));
    xhr.addEventListener('abort', () => reject(new DOMException('The upload was cancelled.', 'AbortError')));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(form);
  });
}
