import { SerializableReturnValue, SerializableValue } from "./serializable.js";
import {
  PartyFetchOptions,
  PartySocket,
  PartySocketOptions
} from "partysocket";

//#region src/client.d.ts
/**
 * Options for creating an AgentClient
 */
type AgentClientOptions<State = unknown> = Omit<
  PartySocketOptions,
  "party" | "room"
> & {
  /** Name of the agent to connect to (ignored if basePath is set) */ agent: string /** Name of the specific Agent instance (ignored if basePath is set) */;
  name?: string;
  /**
   * Full URL path - bypasses agent/name URL construction.
   * When set, the client connects to this path directly.
   * Server must handle routing manually (e.g., with getAgentByName + fetch).
   * @example
   * // Client connects to /user, server routes based on session
   * useAgent({ agent: "UserAgent", basePath: "user" })
   */
  basePath?: string /** Called when the Agent's state is updated */;
  onStateUpdate?: (
    state: State,
    source: "server" | "client"
  ) => void /** Called when a state update fails (e.g., connection is readonly) */;
  onStateUpdateError?: (error: string) => void;
  /**
   * Called when the server sends the agent's identity on connect.
   * Useful when using basePath, as the actual instance name is determined server-side.
   * @param name The actual agent instance name
   * @param agent The agent class name (kebab-case)
   */
  onIdentity?: (name: string, agent: string) => void;
  /**
   * Called when identity changes on reconnect (different instance than before).
   * If not provided and identity changes, a warning will be logged.
   * @param oldName Previous instance name
   * @param newName New instance name
   * @param oldAgent Previous agent class name
   * @param newAgent New agent class name
   */
  onIdentityChange?: (
    oldName: string,
    newName: string,
    oldAgent: string,
    newAgent: string
  ) => void;
  /**
   * Additional path to append to the URL.
   * Works with both standard routing and basePath.
   * @example
   * // With basePath: /user/settings
   * { basePath: "user", path: "settings" }
   * // Standard: /agents/my-agent/room/settings
   * { agent: "MyAgent", name: "room", path: "settings" }
   */
  path?: string;
};
/**
 * Options for streaming RPC calls
 */
type StreamOptions = {
  /** Called when a chunk of data is received */ onChunk?: (
    chunk: unknown
  ) => void /** Called when the stream ends */;
  onDone?: (finalChunk: unknown) => void /** Called when an error occurs */;
  onError?: (error: string) => void;
};
/**
 * Options for RPC calls
 */
type CallOptions = {
  /** Timeout in milliseconds. If the call doesn't complete within this time, it will be rejected. */ timeout?: number /** Streaming options for handling streaming responses */;
  stream?: StreamOptions;
};
/**
 * Options for the agentFetch function
 */
type AgentClientFetchOptions = Omit<PartyFetchOptions, "party" | "room"> & {
  /** Name of the agent to connect to (ignored if basePath is set) */ agent: string /** Name of the specific Agent instance (ignored if basePath is set) */;
  name?: string;
  /**
   * Full URL path - bypasses agent/name URL construction.
   * When set, the request is made to this path directly.
   */
  basePath?: string;
};
/**
 * WebSocket client for connecting to an Agent
 */
declare class AgentClient<State = unknown> extends PartySocket {
  /**
   * @deprecated Use agentFetch instead
   */
  static fetch(_opts: PartyFetchOptions): Promise<Response>;
  agent: string;
  name: string;
  /**
   * Whether the client has received identity from the server.
   * Becomes true after the first identity message is received.
   * Resets to false on connection close.
   */
  identified: boolean;
  /**
   * Promise that resolves when identity has been received from the server.
   * Useful for waiting before making calls that depend on knowing the instance.
   * Resets on connection close so it can be awaited again after reconnect.
   */
  get ready(): Promise<void>;
  private options;
  private _pendingCalls;
  private _readyPromise;
  private _resolveReady;
  private _previousName;
  private _previousAgent;
  private _resetReady;
  constructor(options: AgentClientOptions<State>);
  /**
   * Reject all pending RPC calls with the given reason.
   */
  private _rejectPendingCalls;
  setState(state: State): void;
  /**
   * Close the connection and immediately reject all pending RPC calls.
   * This provides immediate feedback on intentional close rather than
   * waiting for the WebSocket close handshake to complete.
   *
   * Note: Any calls made after `close()` will be rejected when the
   * underlying WebSocket close event fires.
   */
  close(code?: number, reason?: string): void;
  /**
   * Call a method on the Agent
   * @param method Name of the method to call
   * @param args Arguments to pass to the method
   * @param options Options for the call (timeout, streaming) or legacy StreamOptions
   * @returns Promise that resolves with the method's return value
   */
  call<T extends SerializableReturnValue>(
    method: string,
    args?: SerializableValue[],
    options?: CallOptions | StreamOptions
  ): Promise<T>;
  call<T = unknown>(
    method: string,
    args?: unknown[],
    options?: CallOptions | StreamOptions
  ): Promise<T>;
}
/**
 * Make an HTTP request to an Agent
 * @param opts Connection options
 * @param init Request initialization options
 * @returns Promise resolving to a Response
 */
declare function agentFetch(
  opts: AgentClientFetchOptions,
  init?: RequestInit
): Promise<Response>;
//#endregion
export {
  AgentClient,
  AgentClientFetchOptions,
  AgentClientOptions,
  CallOptions,
  StreamOptions,
  agentFetch
};
//# sourceMappingURL=client.d.ts.map
