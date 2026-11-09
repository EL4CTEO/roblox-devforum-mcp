//! Roblox DevForum + creator-docs MCP server.
//!
//! Layout: `http` is the shared network layer (typed TTL cache, request coalescing, per-host
//! concurrency, retry with one overall deadline); `discourse`, `categories` and `docs` are the
//! data sources; `tools` renders them for a model; `mcp` speaks JSON-RPC over stdio.

pub mod args;
pub mod cache;
pub mod categories;
pub mod config;
pub mod ctx;
pub mod discourse;
pub mod docs;
pub mod format;
pub mod http;
pub mod mcp;
pub mod rank;
pub mod time;
pub mod tools;

pub use config::{Config, VERSION};
pub use ctx::Ctx;
