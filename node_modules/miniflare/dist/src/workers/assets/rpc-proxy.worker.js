// src/workers/assets/rpc-proxy.worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";

// src/workers/core/dev-registry-proxy-shared.worker.ts
import { DurableObject } from "cloudflare:workers";
var SERIALIZED_DATE = "___serialized_date___", SERIALIZED_BIGINT = "___serialized_bigint___";
function tailEventsReplacer(_, value) {
  return value instanceof Date ? { [SERIALIZED_DATE]: value.toISOString() } : typeof value == "bigint" ? { [SERIALIZED_BIGINT]: value.toString() } : value;
}
function tailEventsReviver(_, value) {
  if (value && typeof value == "object") {
    if (SERIALIZED_DATE in value)
      return new Date(value[SERIALIZED_DATE]);
    if (SERIALIZED_BIGINT in value)
      return BigInt(value[SERIALIZED_BIGINT]);
  }
  return value;
}

// src/workers/assets/rpc-proxy.worker.ts
var RPCProxyWorker = class extends WorkerEntrypoint {
  async fetch(request) {
    return this.env.ROUTER_WORKER.fetch(request);
  }
  tail(events) {
    return this.env.USER_WORKER.tail(
      JSON.parse(JSON.stringify(events, tailEventsReplacer), tailEventsReviver)
    );
  }
  constructor(ctx, env) {
    return super(ctx, env), new Proxy(this, {
      get(target, prop) {
        return Reflect.has(target, prop) ? Reflect.get(target, prop) : Reflect.get(target.env.USER_WORKER, prop);
      }
    });
  }
};
export {
  RPCProxyWorker as default
};
//# sourceMappingURL=rpc-proxy.worker.js.map
