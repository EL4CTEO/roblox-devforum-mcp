//! MCP over stdio: newline-delimited JSON-RPC 2.0. Each tool call runs as its own task, so a
//! slow search never blocks a quick lookup, and a cancelled request is aborted mid-flight.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;

use crate::config::VERSION;
use crate::ctx::Ctx;
use crate::tools;

pub const INSTRUCTIONS: &str = "Roblox debugging knowledge base. When the user hits a Roblox Studio or runtime problem: \
1) call search_bugs with the literal error text to see if Roblox already has a triaged bug report; \
2) call search_devforum for community threads and workarounds, then get_thread on the most promising topic_id; \
3) call get_engine_api or search_creator_docs to confirm the intended API behaviour before recommending code. \
When something worked before and broke for no clear reason, call get_whats_new first — a Roblox release may explain it. \
Cite the thread URLs you relied on, and note the thread date — Roblox behaviour changes often.";

const PROTOCOLS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

fn response(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

pub fn tool_result(r: &tools::ToolResult) -> Value {
    let mut v = json!({ "content": [{ "type": "text", "text": r.text }] });
    if r.is_error {
        v["isError"] = json!(true);
    }
    v
}

pub fn initialize_result(params: Option<&Value>) -> Value {
    let asked = params.and_then(|p| p.get("protocolVersion")).and_then(Value::as_str);
    let version = asked.filter(|v| PROTOCOLS.contains(v)).unwrap_or(PROTOCOLS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "roblox-devforum", "title": "Roblox DevForum", "version": VERSION },
        "instructions": INSTRUCTIONS,
    })
}

type Running = Arc<Mutex<HashMap<String, AbortHandle>>>;

pub async fn serve(ctx: Arc<Ctx>) -> std::io::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        let mut out = tokio::io::stdout();
        while let Some(line) = rx.recv().await {
            if out.write_all(line.as_bytes()).await.is_err() || out.write_all(b"\n").await.is_err() || out.flush().await.is_err() {
                break;
            }
        }
    });
    let tools_list = Arc::new(json!({ "tools": tools::definitions() }));
    let running: Running = Arc::default();
    let mut lines = BufReader::with_capacity(64 * 1024, tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                let _ = tx.send(error(&Value::Null, -32700, "Parse error"));
                continue;
            }
        };
        match message {
            Value::Array(batch) => {
                for m in batch {
                    dispatch(&ctx, &tx, &running, &tools_list, m);
                }
            }
            m => dispatch(&ctx, &tx, &running, &tools_list, m),
        }
    }
    // Stdin closed: the client is gone. Pending replies have nowhere to go.
    drop(tx);
    writer.abort();
    Ok(())
}

fn dispatch(ctx: &Arc<Ctx>, tx: &mpsc::UnboundedSender<String>, running: &Running, tools_list: &Arc<Value>, message: Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else { return };
    let id = message.get("id").cloned();
    let params = message.get("params");
    let Some(id) = id else {
        // A notification: only cancellation needs action.
        if method == "notifications/cancelled"
            && let Some(rid) = params.and_then(|p| p.get("requestId"))
            && let Some(h) = running.lock().unwrap().remove(&rid.to_string())
        {
            h.abort();
        }
        return;
    };
    let reply = match method {
        "initialize" => response(&id, initialize_result(params)),
        "ping" => response(&id, json!({})),
        "tools/list" => response(&id, (**tools_list).clone()),
        "tools/call" => {
            let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str).map(str::to_string) else {
                let _ = tx.send(error(&id, -32602, "tools/call needs a tool name"));
                return;
            };
            let args = params.and_then(|p| p.get("arguments")).cloned();
            let (ctx, tx2, running2) = (ctx.clone(), tx.clone(), running.clone());
            let key = id.to_string();
            let task_key = key.clone();
            let mut guard = running.lock().unwrap();
            let handle = tokio::spawn(async move {
                let reply = match tools::call(&ctx, &name, args.as_ref()).await {
                    Some(r) => response(&id, tool_result(&r)),
                    None => error(&id, -32602, &format!("Tool {name} not found")),
                };
                running2.lock().unwrap().remove(&task_key);
                let _ = tx2.send(reply);
            });
            guard.insert(key, handle.abort_handle());
            return;
        }
        "resources/list" => response(&id, json!({ "resources": [] })),
        "resources/templates/list" => response(&id, json!({ "resourceTemplates": [] })),
        "prompts/list" => response(&id, json!({ "prompts": [] })),
        _ => error(&id, -32601, &format!("Method not found: {method}")),
    };
    let _ = tx.send(reply);
}
