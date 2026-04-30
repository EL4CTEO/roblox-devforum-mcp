var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __decorateClass = (decorators, target, key, kind) => {
  for (var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target, i = decorators.length - 1, decorator; i >= 0; i--)
    (decorator = decorators[i]) && (result = (kind ? decorator(target, key, result) : decorator(result)) || result);
  return kind && result && __defProp(target, key, result), result;
};

// src/workers/browser-rendering/binding.worker.ts
import assert from "node:assert";
import {
  DELETE,
  GET,
  HttpError,
  MiniflareDurableObject,
  POST,
  PUT,
  Router,
  SharedBindings
} from "miniflare:shared";
function isClosed(ws) {
  return !ws || ws.readyState === WebSocket.CLOSED;
}
function chromeBaseUrl(wsEndpoint) {
  return `http://${new URL(wsEndpoint.replace("ws://", "http://")).host}`;
}
function forwardClose(target, e) {
  target && (!e?.code || e?.code === 1005 || e?.code === 1006 ? target.close() : target.close(e.code, e.reason));
}
var BrowserSession = class extends MiniflareDurableObject {
  sessionInfo;
  chromeWs;
  legacyServerWs;
  wss = [];
  #statusTimeout;
  setSessionInfoRoute = async (req) => {
    this.sessionInfo = await req.json();
    let wsUrl = this.sessionInfo.wsEndpoint.replace("ws://", "http://"), resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
    return assert(resp.webSocket !== null, "Expected a WebSocket response"), this.chromeWs = resp.webSocket, this.chromeWs.accept(), this.chromeWs.addEventListener("message", (m) => {
      if (!this.legacyServerWs)
        return;
      let string = new TextEncoder().encode(m.data), data = new Uint8Array(string.length + 4);
      new DataView(data.buffer).setUint32(0, string.length, !0), data.set(string, 4), this.legacyServerWs.send(data);
    }), this.chromeWs.addEventListener("close", (e) => {
      this.closeSession(e);
    }), this.#scheduleStatusCheck(), new Response(null, { status: 204 });
  };
  getSessionInfoRoute = async () => (isClosed(this.chromeWs) && this.closeSession(), this.sessionInfo ? Response.json(this.sessionInfo) : new Response(null, { status: 204 }));
  connectDevtools = async () => {
    if (assert(
      this.sessionInfo !== void 0,
      "sessionInfo must be set before connecting"
    ), assert(
      this.chromeWs !== void 0,
      "chromeWs must be established before connecting"
    ), this.legacyServerWs !== void 0)
      throw new HttpError(409, "WebSocket already initialized");
    let webSocketPair = new WebSocketPair(), [client, server] = Object.values(webSocketPair);
    return server.accept(), server.addEventListener("message", (m) => {
      m.data !== "ping" && this.chromeWs?.send(
        new TextDecoder().decode(m.data.slice(4))
      );
    }), server.addEventListener("close", (e) => {
      this.closeWebSockets(e);
    }), this.legacyServerWs = server, this.sessionInfo.connectionId = crypto.randomUUID(), this.sessionInfo.connectionStartTime = Date.now(), new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "cf-browser-session-id": this.name }
    });
  };
  jsonVersion = async () => this.#proxyJsonRequest("/json/version");
  jsonList = async () => this.#proxyJsonRequest("/json/list");
  jsonAlias = async () => this.#proxyJsonRequest("/json/list");
  jsonProtocol = async () => this.#proxyJsonRequest("/json/protocol");
  jsonNew = async (_req, _params, url) => this.#proxyJsonRequest(
    `/json/new?${new URLSearchParams({ url: url.searchParams.get("url") ?? "" })}`,
    "PUT"
  );
  jsonActivate = async (_req, params) => this.#proxyJsonRequest(`/json/activate/${params?.targetId}`);
  jsonClose = async (_req, params) => this.#proxyJsonRequest(`/json/close/${params?.targetId}`);
  pageWebSocket = async (_req, params) => this.sessionInfo ? this.#proxyRawWebSocket(
    `${chromeBaseUrl(this.sessionInfo.wsEndpoint).replace("http://", "ws://")}/devtools/page/${params?.pageId}`
  ) : Response.json({ error: "Browser not found" }, { status: 404 });
  closeBrowser = async () => {
    if (this.sessionInfo) {
      let closeUrl = new URL("http://localhost/browser/close");
      closeUrl.searchParams.set("sessionId", this.sessionInfo.sessionId), this.env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch(closeUrl, {
        method: "POST"
      });
    }
    return Response.json({ status: "closed" });
  };
  sessionDetail = async () => this.sessionInfo ? Response.json({
    sessionId: this.sessionInfo.sessionId,
    startTime: this.sessionInfo.startTime,
    connectionId: this.sessionInfo.connectionId,
    connectionStartTime: this.sessionInfo.connectionStartTime
  }) : Response.json({ error: "Session not found" }, { status: 404 });
  connect = async (_req) => {
    assert(
      this.sessionInfo !== void 0,
      "sessionInfo must be set before connecting"
    );
    let wsUrl = this.sessionInfo.wsEndpoint.replace("ws://", "http://"), resp = await this.#proxyRawWebSocket(wsUrl);
    return this.sessionInfo.connectionId = crypto.randomUUID(), this.sessionInfo.connectionStartTime = Date.now(), new Response(null, {
      status: resp.status,
      webSocket: resp.webSocket,
      headers: { "cf-browser-session-id": this.name }
    });
  };
  closeWebSockets(e) {
    forwardClose(this.legacyServerWs, e);
    for (let { chrome, server } of this.wss)
      forwardClose(chrome, e), forwardClose(server, e);
    this.legacyServerWs = void 0, this.wss = [], this.sessionInfo && (this.sessionInfo.connectionId = void 0, this.sessionInfo.connectionStartTime = void 0);
  }
  closeSession(e) {
    this.#statusTimeout !== void 0 && (this.timers.clearTimeout(this.#statusTimeout), this.#statusTimeout = void 0), this.closeWebSockets(e), forwardClose(this.chromeWs, e), this.chromeWs = void 0, this.sessionInfo = void 0;
  }
  async #proxyRawWebSocket(targetWsUrl) {
    let webSocketPair = new WebSocketPair(), [client, server] = Object.values(webSocketPair);
    server.accept();
    let response = await fetch(targetWsUrl.replace("ws://", "http://"), {
      headers: { Upgrade: "websocket" }
    });
    assert(response.webSocket !== null, "Expected a WebSocket response");
    let chrome = response.webSocket;
    chrome.accept();
    let pair = { chrome, server };
    return this.wss.push(pair), chrome.addEventListener("message", (m) => server.send(m.data)), server.addEventListener("message", (m) => chrome.send(m.data)), server.addEventListener("close", (e) => {
      forwardClose(chrome, e), forwardClose(server, e), this.wss = this.wss.filter((p) => p !== pair);
    }), chrome.addEventListener("close", (e) => {
      forwardClose(server, e), forwardClose(chrome, e), this.wss = this.wss.filter((p) => p !== pair);
    }), new Response(null, { status: 101, webSocket: client });
  }
  async #proxyJsonRequest(chromePath, method = "GET") {
    if (!this.sessionInfo)
      return Response.json({ error: "Browser not found" }, { status: 404 });
    let resp = await fetch(
      `${chromeBaseUrl(this.sessionInfo.wsEndpoint)}${chromePath}`,
      { method }
    );
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { "Content-Type": "application/json" }
    });
  }
  async #checkStatus() {
    if (this.sessionInfo) {
      let url = new URL("http://localhost/browser/status");
      url.searchParams.set("sessionId", this.sessionInfo.sessionId), (await this.env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch(url)).ok || this.closeSession();
    }
  }
  #scheduleStatusCheck() {
    this.#statusTimeout === void 0 && (this.#statusTimeout = this.timers.setTimeout(async () => {
      this.#statusTimeout = void 0, await this.#checkStatus(), this.chromeWs && this.#scheduleStatusCheck();
    }, 1e3));
  }
};
__decorateClass([
  POST("/session-info")
], BrowserSession.prototype, "setSessionInfoRoute", 2), __decorateClass([
  GET("/session-info")
], BrowserSession.prototype, "getSessionInfoRoute", 2), __decorateClass([
  GET("/v1/connectDevtools")
], BrowserSession.prototype, "connectDevtools", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/version")
], BrowserSession.prototype, "jsonVersion", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/list")
], BrowserSession.prototype, "jsonList", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json")
], BrowserSession.prototype, "jsonAlias", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/protocol")
], BrowserSession.prototype, "jsonProtocol", 2), __decorateClass([
  PUT("/v1/devtools/browser/:sessionId/json/new")
], BrowserSession.prototype, "jsonNew", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/activate/:targetId")
], BrowserSession.prototype, "jsonActivate", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/close/:targetId")
], BrowserSession.prototype, "jsonClose", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/page/:pageId")
], BrowserSession.prototype, "pageWebSocket", 2), __decorateClass([
  DELETE("/v1/devtools/browser/:sessionId")
], BrowserSession.prototype, "closeBrowser", 2), __decorateClass([
  GET("/v1/devtools/session/:sessionId")
], BrowserSession.prototype, "sessionDetail", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId")
], BrowserSession.prototype, "connect", 2);
var BrowserRenderingRouter = class extends Router {
  constructor(env) {
    super();
    this.env = env;
  }
  #callSession(sessionId, request) {
    let cf = { miniflare: { name: sessionId } };
    return this.env.BrowserSession.get(
      this.env.BrowserSession.idFromName(sessionId)
    ).fetch(request, {
      cf
    });
  }
  #fetchSession(sessionId, path, init) {
    let cf = { miniflare: { name: sessionId } };
    return this.env.BrowserSession.get(
      this.env.BrowserSession.idFromName(sessionId)
    ).fetch(`http://placeholder${path}`, {
      ...init,
      cf
    });
  }
  async #acquireSession() {
    let sessionInfo = await this.env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch("http://localhost/browser/launch").then((r) => r.json());
    return await this.#fetchSession(sessionInfo.sessionId, "/session-info", {
      method: "POST",
      body: JSON.stringify(sessionInfo)
    }), sessionInfo;
  }
  async #getActiveSessions() {
    let sessionIds = await this.env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch("http://localhost/browser/sessionIds").then((r) => r.json());
    return (await Promise.all(
      sessionIds.map(async (sessionId) => {
        let resp = await this.#fetchSession(sessionId, "/session-info");
        if (resp.status === 204)
          return null;
        let sessionInfo = await resp.json();
        return {
          sessionId: sessionInfo.sessionId,
          startTime: sessionInfo.startTime,
          connectionId: sessionInfo.connectionId,
          connectionStartTime: sessionInfo.connectionStartTime
        };
      })
    )).filter(Boolean);
  }
  acquireRoute = async () => {
    let sessionInfo = await this.#acquireSession();
    return Response.json({ sessionId: sessionInfo.sessionId });
  };
  sessionsRoute = async () => Response.json({ sessions: await this.#getActiveSessions() });
  limitsRoute = async () => Response.json({
    maxConcurrentSessions: 6,
    allowedBrowserAcquisitions: 6,
    timeUntilNextAllowedBrowserAcquisition: 0
  });
  historyRoute = async () => Response.json([]);
  sessionListRoute = async () => Response.json(await this.#getActiveSessions());
  connectDevtoolsRoute = async (req, _params, url) => {
    let sessionId = url.searchParams.get("browser_session");
    return sessionId ? this.#callSession(sessionId, req) : new Response("browser_session must be set", { status: 400 });
  };
  acquireBrowserRoute = async () => {
    let sessionInfo = await this.#acquireSession();
    return Response.json({ sessionId: sessionInfo.sessionId });
  };
  connectBrowserRoute = async (req) => {
    let sessionInfo = await this.#acquireSession(), doUrl = new URL(req.url);
    return doUrl.pathname = `/v1/devtools/browser/${sessionInfo.sessionId}`, this.#callSession(
      sessionInfo.sessionId,
      new Request(doUrl, {
        method: req.method,
        headers: {
          ...Object.fromEntries(req.headers),
          "x-session-id": sessionInfo.sessionId
        }
      })
    );
  };
  sessionDetailRoute = async (req, params) => this.#callSession(params.sessionId, req);
  closeBrowserRoute = async (req, params) => {
    let { sessionId } = params;
    await this.#callSession(sessionId, req);
    for (let i = 0; i < 50; i++) {
      let statusUrl = new URL("http://localhost/browser/status");
      if (statusUrl.searchParams.set("sessionId", sessionId), (await this.env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch(statusUrl)).status === 410)
        break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return Response.json({ status: "closed" });
  };
  connectBrowserSessionRoute = async (req, params, _url) => {
    let doUrl = new URL(req.url);
    return this.#callSession(params.sessionId, new Request(doUrl, req));
  };
  jsonVersionRoute = async (req, params) => this.#callSession(params.sessionId, req);
  jsonListRoute = async (req, params) => this.#callSession(params.sessionId, req);
  jsonAliasRoute = async (req, params) => this.#callSession(params.sessionId, req);
  jsonProtocolRoute = async (req, params) => this.#callSession(params.sessionId, req);
  jsonNewRoute = async (req, params) => this.#callSession(params.sessionId, req);
  jsonActivateRoute = async (req, params) => this.#callSession(params.sessionId, req);
  jsonCloseRoute = async (req, params) => this.#callSession(params.sessionId, req);
  pageWebSocketRoute = async (req, params) => this.#callSession(params.sessionId, req);
};
__decorateClass([
  GET("/v1/acquire")
], BrowserRenderingRouter.prototype, "acquireRoute", 2), __decorateClass([
  GET("/v1/sessions")
], BrowserRenderingRouter.prototype, "sessionsRoute", 2), __decorateClass([
  GET("/v1/limits")
], BrowserRenderingRouter.prototype, "limitsRoute", 2), __decorateClass([
  GET("/v1/history")
], BrowserRenderingRouter.prototype, "historyRoute", 2), __decorateClass([
  GET("/v1/devtools/session")
], BrowserRenderingRouter.prototype, "sessionListRoute", 2), __decorateClass([
  GET("/v1/connectDevtools")
], BrowserRenderingRouter.prototype, "connectDevtoolsRoute", 2), __decorateClass([
  POST("/v1/devtools/browser")
], BrowserRenderingRouter.prototype, "acquireBrowserRoute", 2), __decorateClass([
  GET("/v1/devtools/browser")
], BrowserRenderingRouter.prototype, "connectBrowserRoute", 2), __decorateClass([
  GET("/v1/devtools/session/:sessionId")
], BrowserRenderingRouter.prototype, "sessionDetailRoute", 2), __decorateClass([
  DELETE("/v1/devtools/browser/:sessionId")
], BrowserRenderingRouter.prototype, "closeBrowserRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId")
], BrowserRenderingRouter.prototype, "connectBrowserSessionRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/version")
], BrowserRenderingRouter.prototype, "jsonVersionRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/list")
], BrowserRenderingRouter.prototype, "jsonListRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json")
], BrowserRenderingRouter.prototype, "jsonAliasRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/protocol")
], BrowserRenderingRouter.prototype, "jsonProtocolRoute", 2), __decorateClass([
  PUT("/v1/devtools/browser/:sessionId/json/new")
], BrowserRenderingRouter.prototype, "jsonNewRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/activate/:targetId")
], BrowserRenderingRouter.prototype, "jsonActivateRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/json/close/:targetId")
], BrowserRenderingRouter.prototype, "jsonCloseRoute", 2), __decorateClass([
  GET("/v1/devtools/browser/:sessionId/page/:pageId")
], BrowserRenderingRouter.prototype, "pageWebSocketRoute", 2);
var binding_worker_default = {
  fetch(request, env) {
    return new BrowserRenderingRouter(env).fetch(request);
  }
};
export {
  BrowserSession,
  binding_worker_default as default
};
//# sourceMappingURL=binding.worker.js.map
