import { VideoPlaybackAbrRequest } from 'googlevideo/protos';
import type { RequestState } from './playback-session';

type ObservedWindow = Window & { __tePlaybackRequest?: RequestState };

/** Observe the player's own requests; never change its request or response. */
export function installObserver(): () => void {
  const page = window as ObservedWindow;
  if (page.__tePlaybackRequest?.installed) return () => undefined;
  const state: RequestState = { installed: true };
  page.__tePlaybackRequest = state;
  const toBase64 = (bytes: Uint8Array) => {
    let value = '';
    for (const byte of bytes) value += String.fromCharCode(byte);
    return btoa(value);
  };
  const capture = async (address: string, body: unknown, id: string | null) => {
    try {
      const url = new URL(address, location.href);
      if (
        !id ||
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.googlevideo.com') ||
        url.pathname !== '/videoplayback'
      )
        return;
      let bytes: Uint8Array;
      if (ArrayBuffer.isView(body))
        bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body.slice(0));
      else if (body instanceof Blob && body.size <= 1024 * 1024)
        bytes = new Uint8Array(await body.arrayBuffer());
      else return;
      if (!bytes.length || bytes.length > 1024 * 1024) return;
      const request = VideoPlaybackAbrRequest.decode(bytes);
      const config = request.videoPlaybackUstreamerConfig;
      const clientInfo = request.streamerContext?.clientInfo;
      if (!config?.length || !clientInfo || id !== getId()) return;
      state.session = {
        videoId: id,
        url: url.href,
        config: toBase64(config),
        clientInfo: { ...clientInfo },
        token: request.streamerContext?.poToken?.length
          ? toBase64(request.streamerContext.poToken)
          : undefined,
      };
    } catch {
      /* An unrelated or incomplete request must never affect playback. */
    }
  };
  const getId = () =>
    new URL(location.href).searchParams.get('v') ||
    location.pathname.match(/^\/shorts\/([^/]+)/)?.[1] ||
    null;
  const originalFetch = window.fetch;
  const observedFetch = new Proxy(originalFetch, {
    apply(target, receiver, args: Parameters<typeof fetch>) {
      const [input, init] = args;
      const id = getId();
      const address = input instanceof Request ? input.url : String(input);
      const method = init?.method || (input instanceof Request ? input.method : 'GET');
      if (method.toUpperCase() === 'POST') {
        if (init?.body) void capture(address, init.body, id);
        else if (
          input instanceof Request &&
          /^https:\/\/[^/]+\.googlevideo\.com\/videoplayback(?:\?|$)/.test(address)
        )
          void input
            .clone()
            .arrayBuffer()
            .then(body => capture(address, body, id))
            .catch(() => undefined);
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  window.fetch = observedFetch;
  const addresses = new WeakMap<XMLHttpRequest, string>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const observedOpen = new Proxy(originalOpen, {
    apply(target, receiver: XMLHttpRequest, args: unknown[]) {
      if (String(args[0]).toUpperCase() === 'POST') addresses.set(receiver, String(args[1]));
      else addresses.delete(receiver);
      return Reflect.apply(target, receiver, args);
    },
  });
  const observedSend = new Proxy(originalSend, {
    apply(target, receiver: XMLHttpRequest, args: unknown[]) {
      const address = addresses.get(receiver);
      if (address) void capture(address, args[0], getId());
      return Reflect.apply(target, receiver, args);
    },
  });
  XMLHttpRequest.prototype.open = observedOpen;
  XMLHttpRequest.prototype.send = observedSend;
  const clear = () => {
    state.session = undefined;
  };
  window.addEventListener('yt-navigate-start', clear);
  window.addEventListener('popstate', clear);
  return () => {
    if (window.fetch === observedFetch) window.fetch = originalFetch;
    if (XMLHttpRequest.prototype.open === observedOpen)
      XMLHttpRequest.prototype.open = originalOpen;
    if (XMLHttpRequest.prototype.send === observedSend)
      XMLHttpRequest.prototype.send = originalSend;
    window.removeEventListener('yt-navigate-start', clear);
    window.removeEventListener('popstate', clear);
    if (page.__tePlaybackRequest === state) delete page.__tePlaybackRequest;
  };
}
