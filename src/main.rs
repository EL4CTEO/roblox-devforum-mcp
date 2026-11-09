//! roblox-devforum-mcp — MCP server exposing the Roblox DevForum and the official creator
//! documentation so an AI agent can debug Roblox games against real answers.

use std::sync::Arc;

use roblox_devforum_mcp::{Ctx, mcp};

fn main() {
    // One crypto provider for every TLS connection; ring keeps the build free of C toolchains.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("devforum-mcp").enable_all().build() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("roblox-devforum-mcp failed to start: {err}");
            std::process::exit(1);
        }
    };

    let result = runtime.block_on(async {
        let ctx = Arc::new(Ctx::from_env().map_err(std::io::Error::other)?);
        // Pull the live category tree in the background, so the first result already names
        // categories correctly. Startup never waits on it, and never fails if it fails.
        let warm = ctx.clone();
        tokio::spawn(async move { warm.ensure_categories().await });
        mcp::serve(ctx).await
    });

    if let Err(err) = result {
        eprintln!("roblox-devforum-mcp failed: {err}");
        std::process::exit(1);
    }
    // Pending background work (a category refresh, a disk-cache write) is not worth waiting on.
    runtime.shutdown_background();
}
