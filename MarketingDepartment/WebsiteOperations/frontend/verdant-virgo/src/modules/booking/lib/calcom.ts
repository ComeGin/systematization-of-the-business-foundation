// Cal.com（SaaS）の埋め込みの読み込み（DD-02 の 7 節・ADR-24）。公式の埋め込みの loader と同じ手順を、
// 読み込みの失敗を拾えるように書き直したもの（embed.js の onerror を見る）。
// 出典: https://cal.com/help/embedding/embed-events（linkReady・linkFailed・bookingSuccessfulV2）

type CalApi = ((...args: unknown[]) => void) & { q?: unknown[] };
interface CalGlobal extends CalApi {
  loaded?: boolean;
  ns: Record<string, CalApi>;
}

declare global {
  interface Window {
    Cal?: CalGlobal;
  }
}

const NAMESPACE = 'consult';

/** embed.js を読み込み、名前空間つきの API を返す。読み込みに失敗したら onError を呼ぶ */
export function loadCalNamespace(base: string, onError: () => void): CalApi {
  const w = window;
  if (!w.Cal) {
    const push = (api: CalApi, args: unknown) => (api.q ??= []).push(args);
    const cal = function (this: unknown, ...args: unknown[]) {
      const self = w.Cal!;
      if (args[0] === 'init') {
        const namespace = args[1];
        if (typeof namespace === 'string') {
          const api: CalApi = function (...apiArgs: unknown[]) {
            push(api, apiArgs);
          };
          self.ns[namespace] ??= api;
          push(self.ns[namespace], args);
          push(self, ['initNamespace', namespace]);
          return;
        }
      }
      push(self, args);
    } as CalGlobal;
    cal.ns = {};
    cal.q = [];
    cal.loaded = true;
    w.Cal = cal;
    const script = document.createElement('script');
    script.src = `${base}/embed/embed.js`;
    script.async = true;
    script.onerror = onError;
    document.head.appendChild(script);
  }
  w.Cal('init', NAMESPACE, { origin: base });
  return w.Cal.ns[NAMESPACE];
}
