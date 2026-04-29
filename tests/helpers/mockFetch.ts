type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

export interface MockFetch {
  fn: typeof fetch;
  on: (matcher: string | RegExp, handler: Handler) => void;
  reset: () => void;
  calls: string[];
}

export function createMockFetch(): MockFetch {
  const handlers: { match: string | RegExp; handler: Handler }[] = [];
  const calls: string[] = [];

  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    for (const { match, handler } of handlers) {
      const ok = typeof match === "string" ? url.includes(match) : match.test(url);
      if (ok) return handler(url, init);
    }
    return new Response(`unmocked: ${url}`, { status: 599 });
  };

  return {
    fn,
    on(match, handler) {
      handlers.push({ match, handler });
    },
    reset() {
      handlers.length = 0;
      calls.length = 0;
    },
    calls,
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

export function textResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html", ...(init.headers ?? {}) },
    ...init,
  });
}
