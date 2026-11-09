//! End-to-end tool calls against a fake network: a tiny API dump, docs tree and forum, so
//! the text a model actually sees is checked without touching the real services.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use roblox_devforum_mcp::http::{FetchError, Headers, Response, Transport};
use roblox_devforum_mcp::{Config, Ctx, tools};
use serde_json::{Value, json};

const DOCS: &str = "content/en-us/reference/engine/";

fn dump() -> Value {
    json!({
      "Classes": [
        { "Name": "Instance", "Tags": ["NotCreatable"], "Members": [
          { "MemberType": "Function", "Name": "FindFirstChild", "ReturnType": { "Name": "Instance" }, "Parameters": [{ "Name": "name", "Type": { "Name": "string" } }] },
          { "MemberType": "Property", "Name": "Parent", "ValueType": { "Name": "Instance" } },
          { "MemberType": "Function", "Name": "findFirstChild", "Tags": ["Deprecated"], "ReturnType": { "Name": "Instance" }, "Parameters": [{ "Name": "name", "Type": { "Name": "string" } }] }
        ]},
        { "Name": "DataModel", "Superclass": "Instance", "Members": [
          { "MemberType": "Property", "Name": "Workspace", "ValueType": { "Name": "Workspace" } },
          { "MemberType": "Property", "Name": "lighting", "ValueType": { "Name": "Instance" }, "Tags": ["Deprecated"] }
        ]},
        { "Name": "Lighting", "Superclass": "Instance", "Members": [{ "MemberType": "Property", "Name": "ClockTime", "ValueType": { "Name": "float" } }] },
        { "Name": "Script", "Superclass": "Instance", "Members": [] },
        { "Name": "Workspace", "Superclass": "Instance", "Tags": ["NotCreatable", "Service"], "Members": [] },
        { "Name": "Players", "Superclass": "Instance", "Tags": ["NotCreatable", "Service"], "Members": [{ "MemberType": "Property", "Name": "LocalPlayer", "ValueType": { "Name": "Player" } }] },
        { "Name": "Player", "Superclass": "Instance", "Members": [{ "MemberType": "Property", "Name": "Character", "ValueType": { "Name": "Model" } }] },
        { "Name": "Model", "Superclass": "Instance", "Members": [] },
        { "Name": "Humanoid", "Superclass": "Instance", "Members": [
          { "MemberType": "Function", "Name": "MoveTo", "ReturnType": { "Name": "null" }, "Parameters": [{ "Name": "location", "Type": { "Name": "Vector3" } }] },
          { "MemberType": "Property", "Name": "Health", "ValueType": { "Name": "float" } },
          { "MemberType": "Property", "Name": "MaxHealth", "ValueType": { "Name": "float" } }
        ]}
      ],
      "Enums": [
        { "Name": "Material", "Items": [{ "Name": "Neon", "Value": 288 }, { "Name": "Plastic", "Value": 256 }] },
        { "Name": "Font", "Items": [{ "Name": "Arial", "Value": 1 }] }
      ]
    })
}

fn page(rel: &str) -> Option<&'static str> {
    Some(match rel {
        "datatypes/Font.yaml" => {
            "name: Font\ntype: datatype\nsummary: |\n  A font.\nconstructors:\n  - name: Font.new\n    summary: |\n      Makes one.\n"
        }
        "libraries/task.yaml" => {
            "name: task\ntype: library\nfunctions:\n  - name: task.wait\n    summary: |\n      Yields.\n    parameters:\n      - name: duration\n        type: number\n    tags: []\n    deprecation_message: ''\n"
        }
        "globals/LuaGlobals.yaml" => {
            "name: Lua globals\ntype: global\nfunctions:\n  - name: print\n    summary: |\n      Prints.\n    tags: []\n"
        }
        "globals/RobloxGlobals.yaml" => {
            "name: Roblox globals\ntype: global\nfunctions:\n  - name: wait\n    summary: |\n      Yields, throttled.\n    parameters:\n      - name: seconds\n        type: number\n    tags:\n      - Deprecated\n    deprecation_message: |\n      This method has been superseded by `Library.task.wait()` and should not be\n      used for future work.\n"
        }
        _ => return None,
    })
}

type Forum = Box<dyn Fn(&str) -> Option<Result<Value, ()>> + Send + Sync>;

struct Fake {
    forum: Forum,
}

fn ok_json(v: Value) -> Result<Response, FetchError> {
    Ok(Response { status: 200, retry_after: None, body: Bytes::from(v.to_string()) })
}

fn status(code: u16) -> Result<Response, FetchError> {
    Ok(Response { status: code, retry_after: None, body: Bytes::new() })
}

impl Transport for Fake {
    fn get<'a>(&'a self, url: &'a str, _h: Headers, _t: Duration) -> BoxFuture<'a, Result<Response, FetchError>> {
        async move {
            if url.contains("api.github.com") {
                let names = [
                    "datatypes/Font.yaml",
                    "libraries/task.yaml",
                    "globals/LuaGlobals.yaml",
                    "globals/RobloxGlobals.yaml",
                    "datatypes/Vector3.yaml",
                ];
                let tree: Vec<Value> = names.iter().map(|p| json!({ "path": format!("{DOCS}{p}"), "type": "blob" })).collect();
                return ok_json(json!({ "tree": tree }));
            }
            if url.contains("API-Dump.json") {
                return ok_json(dump());
            }
            if url.contains("raw.githubusercontent.com/Roblox/creator-docs") {
                let rel = &url[url.find(DOCS).unwrap() + DOCS.len()..];
                return match page(rel) {
                    Some(p) => Ok(Response { status: 200, retry_after: None, body: Bytes::from_static(p.as_bytes()) }),
                    None => status(404),
                };
            }
            if url.contains("/site.json") {
                return ok_json(json!({ "categories": [] }));
            }
            match (self.forum)(url) {
                Some(Ok(v)) => ok_json(v),
                Some(Err(())) => Err(FetchError::Network("fetch failed".into())),
                None => status(404),
            }
        }
        .boxed()
    }
}

fn ctx_with(forum: Forum) -> Arc<Ctx> {
    let dir = std::env::temp_dir().join(format!("devforum-mcp-test-{}-{}", std::process::id(), rand_suffix()));
    let cfg = Config { max_retries: 0, cache_dir: dir, ..Config::defaults() };
    Arc::new(Ctx::new(cfg, Arc::new(Fake { forum })))
}

fn rand_suffix() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

fn no_forum() -> Arc<Ctx> {
    ctx_with(Box::new(|_| None))
}

async fn call(ctx: &Arc<Ctx>, name: &str, args: Value) -> (String, bool) {
    let r = tools::call(ctx, name, Some(&args)).await.expect("tool exists");
    (r.text, r.is_error)
}

fn line_for<'a>(text: &'a str, entry: &str) -> &'a str {
    text.lines().find(|l| l.contains(&format!(" {entry} —"))).unwrap_or("")
}

#[tokio::test]
async fn every_tool_is_listed_read_only() {
    let defs = tools::definitions();
    let mut names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "check_api_health",
            "get_engine_api",
            "get_replies",
            "get_thread",
            "get_weekly_recap",
            "get_whats_new",
            "list_categories",
            "list_recent",
            "search_bugs",
            "search_creator_docs",
            "search_devforum"
        ]
    );
    for d in &defs {
        assert!(d["description"].as_str().unwrap().len() > 40);
        assert_eq!(d["inputSchema"]["type"], "object");
        assert_eq!(d["annotations"]["readOnlyHint"], true);
    }
}

#[tokio::test]
async fn invalid_arguments_fail_without_the_network() {
    let ctx = no_forum();
    assert!(call(&ctx, "get_engine_api", json!({ "name": "x" })).await.1);
    let (text, err) = call(&ctx, "get_thread", json!({ "topic": "nonsense" })).await;
    assert!(err && text.to_lowercase().contains("topic id"));
}

#[tokio::test]
async fn health_tells_spellings_twins_libraries_and_globals_apart() {
    let ctx = no_forum();
    let members = [
        "Instance.FindFirstChild",
        "Instance.findFirstChild",
        "Humanoid.moveTo",
        "Humanoid.new",
        "Instance.new",
        "Enum.Material.neon",
        "task.wait",
        "Task.wait",
        "wait",
        "print",
        "Vector3.Magnitude",
    ];
    let (text, _) = call(&ctx, "check_api_health", json!({ "members": members })).await;
    assert!(line_for(&text, "Instance.FindFirstChild").starts_with("OK "), "{text}");
    assert!(line_for(&text, "Instance.findFirstChild").starts_with("DEPRECATED "));
    let l = line_for(&text, "Humanoid.moveTo");
    assert!(l.starts_with("WRONG CASE ") && l.contains("Humanoid:MoveTo"), "{l}");
    let l = line_for(&text, "Humanoid.new");
    assert!(l.starts_with("NOT FOUND ") && l.contains("Instance.new(\"Humanoid\")"), "{l}");
    assert!(line_for(&text, "Instance.new").starts_with("OK "));
    let l = line_for(&text, "Enum.Material.neon");
    assert!(l.starts_with("WRONG CASE ") && l.contains("Enum.Material.Neon"));
    let l = line_for(&text, "task.wait");
    assert!(l.starts_with("OK ") && l.contains("task library"), "{l}");
    let l = line_for(&text, "Task.wait");
    assert!(l.starts_with("WRONG CASE ") && l.contains("task.wait"), "{l}");
    let l = line_for(&text, "wait");
    assert!(l.starts_with("DEPRECATED ") && l.contains("superseded by `task.wait()`"), "{l}");
    assert!(line_for(&text, "print").starts_with("OK "));
    assert!(line_for(&text, "Vector3.Magnitude").starts_with("UNKNOWN "), "{text}");
}

#[tokio::test]
async fn engine_api_reads_libraries_and_void_returns() {
    let ctx = no_forum();
    let (text, err) = call(&ctx, "get_engine_api", json!({ "name": "task.wait" })).await;
    assert!(!err && text.contains("task is a Luau library") && text.contains("- name: task.wait"), "{text}");
    let (text, _) = call(&ctx, "get_engine_api", json!({ "name": "Humanoid.MoveTo" })).await;
    assert!(text.contains("MoveTo(location: Vector3) -> ()"), "{text}");
}

#[tokio::test]
async fn search_keeps_phrasings_that_answered() {
    let ctx = ctx_with(Box::new(|url| {
        if !url.contains("/search.json") {
            return None;
        }
        if url.contains("q=broken") {
            return Some(Err(()));
        }
        Some(Ok(
            json!({ "topics": [{ "id": 7, "title": "TweenService tween not playing", "posts_count": 3 }], "posts": [{ "id": 70, "topic_id": 7, "post_number": 1 }] }),
        ))
    }));
    let (text, err) = call(&ctx, "search_devforum", json!({ "query": ["tween not playing", "broken phrasing"] })).await;
    assert!(!err, "{text}");
    assert!(text.contains("TweenService tween not playing"));
    assert!(text.contains("\"broken phrasing\" could not be searched and was skipped"), "{text}");
}

fn post(n: i64, base: u64, extra: Value) -> Value {
    let mut p = json!({ "id": base + n as u64, "post_number": n, "username": format!("u{n}"), "cooked": format!("<p>post {n}</p>") });
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

#[tokio::test]
async fn thread_hoists_an_off_chunk_accepted_answer() {
    let ctx = ctx_with(Box::new(|url| {
        if url.contains("/posts/by_number/55/40.json") {
            return Some(Ok(post(40, 1000, json!({ "cooked": "<p>the real answer</p>", "accepted_answer": true }))));
        }
        url.contains("/t/55.json").then(|| {
            Ok(json!({
                "id": 55, "title": "Long thread", "posts_count": 43, "accepted_answer": { "post_number": 40 },
                "post_stream": { "posts": (1..=20).map(|i| post(i, 1000, json!({}))).collect::<Vec<_>>(), "stream": (1001..=1043).collect::<Vec<u64>>() }
            }))
        })
    }));
    let (text, _) = call(&ctx, "get_thread", json!({ "topic": 55, "max_posts": 3 })).await;
    assert!(text.contains("#40 by u40 ✅ ACCEPTED ANSWER"), "{text}");
    assert!(text.contains("the real answer"));
    assert!(text.contains("answered (a reply the asker marked as the solution)"));
}

#[tokio::test]
async fn enum_shorthand_gets_item_and_case_checks() {
    let ctx = no_forum();
    let (text, _) = call(
        &ctx,
        "check_api_health",
        json!({ "members": ["Material.Neon", "Material.TotallyFake", "material", "Font.new", "Font.Arial"] }),
    )
    .await;
    let l = line_for(&text, "Material.Neon");
    assert!(l.starts_with("OK ") && l.contains("Write it Enum.Material.Neon"), "{l}");
    let l = line_for(&text, "Material.TotallyFake");
    assert!(l.starts_with("NOT FOUND ") && l.contains("no item \"TotallyFake\""), "{l}");
    let l = line_for(&text, "material");
    assert!(l.starts_with("WRONG CASE ") && l.contains("Enum.Material"), "{l}");
    let l = line_for(&text, "Font.new");
    assert!(l.starts_with("OK ") && l.contains("datatype"), "{l}");
    let l = line_for(&text, "Font.Arial");
    assert!(l.starts_with("OK ") && l.contains("Enum.Font.Arial = 1"), "{l}");
}

#[tokio::test]
async fn engine_api_resolves_enum_shorthand_and_exact_members() {
    let ctx = no_forum();
    let (text, err) = call(&ctx, "get_engine_api", json!({ "name": "Material.Neon" })).await;
    assert!(!err && text.starts_with("Enum.Material.Neon = 288\n\nEnum.Material has "), "{text}");
    let (text, _) = call(&ctx, "get_engine_api", json!({ "name": "Enum.Material.Fake" })).await;
    assert!(text.starts_with("Enum.Material has no item \"Fake\""), "{text}");
    let (text, _) = call(&ctx, "get_engine_api", json!({ "name": "Enum.Material.neon" })).await;
    assert!(text.contains("write Enum.Material.Neon"));
    let (text, _) = call(&ctx, "get_engine_api", json!({ "name": "Enum.Material" })).await;
    assert!(text.starts_with("Enum.Material\nNeon = 288"), "{text}");
    let (text, _) = call(&ctx, "get_engine_api", json!({ "name": "Humanoid.Health" })).await;
    assert!(text.contains("Health: float") && !text.contains("MaxHealth"), "{text}");
    let (text, _) = call(&ctx, "get_engine_api", json!({ "name": "Humanoid", "filter": "health" })).await;
    assert!(text.contains("MaxHealth"));
}

#[tokio::test]
async fn staff_reply_leads_community_replies() {
    let ctx = ctx_with(Box::new(|url| {
        url.contains("/t/66.json").then(|| {
            Ok(json!({
                "id": 66, "title": "Engine bug", "posts_count": 4,
                "post_stream": { "posts": [
                    post(1, 2000, json!({})),
                    post(2, 2000, json!({ "actions_summary": [{ "id": 2, "count": 30 }] })),
                    post(3, 2000, json!({ "actions_summary": [{ "id": 2, "count": 10 }] })),
                    post(4, 2000, json!({ "username": "engineer", "staff": false, "primary_group_name": "Roblox_Staff", "flair_name": "Roblox_Staff" }))
                ], "stream": [2001, 2002, 2003, 2004] }
            }))
        })
    }));
    let (text, _) = call(&ctx, "get_thread", json!({ "topic": 66, "max_posts": 2 })).await;
    assert!(text.contains("#4 by engineer (Roblox staff)"), "{text}");
    assert!(!text.contains("#2 by u2"));
}

#[tokio::test]
async fn weekly_recap_reads_the_pinned_current_one() {
    let ctx = ctx_with(Box::new(|url| {
        url.contains("/tag/weekly-recap/l/latest.json").then(|| {
            Ok(json!({ "topic_list": { "topics": [
                { "id": 3, "title": "Weekly Recap: September 21 - 25", "pinned": true, "pinned_globally": true, "created_at": "2026-09-25T21:00:00Z" },
                { "id": 2, "title": "Weekly Recap: September 14–20", "created_at": "2026-09-18T22:00:00Z" },
                { "id": 1, "title": "About the Announcements category", "pinned": true, "created_at": "2021-01-01T08:00:00Z" }
            ] } }))
        })
    }));
    let (text, _) = call(&ctx, "get_weekly_recap", json!({ "list": true, "limit": 5 })).await;
    assert!(text.starts_with("2 Weekly Recaps"), "{text}");
    let a = text.find("- Weekly Recap: September 21 - 25\n").unwrap();
    let b = text.find("September 14–20").unwrap();
    assert!(a < b && !text.contains("About the"));
}

#[tokio::test]
async fn health_follows_dotted_paths() {
    let ctx = no_forum();
    let members = [
        "game.Players.LocalPlayer.Character",
        "game.Players.LocalPlayer.Character.Humanoid",
        "game.Players.LocalPlayer.Charcter",
        "workspace.Map.Door.Touched",
        "LoadLibrary",
        "game.Lighting.ClockTime",
        "script.Parent.Touched",
    ];
    let (text, _) = call(&ctx, "check_api_health", json!({ "members": members })).await;
    let check = |entry: &str, start: &str, has: &str| {
        let l = line_for(&text, entry);
        assert!(l.starts_with(start) && l.contains(has), "{entry}: {l}");
    };
    check("game.Players.LocalPlayer.Character", "OK ", "Character: Model");
    check("game.Players.LocalPlayer.Character.Humanoid", "OK ", "child named \"Humanoid\"");
    check("game.Players.LocalPlayer.Charcter", "NOT FOUND ", "Player has no member \"Charcter\"");
    check("workspace.Map.Door.Touched", "UNCHECKED ", "\"Map\" is not a member of Workspace");
    check("game.Lighting.ClockTime", "OK ", "ClockTime: float");
    check("script.Parent.Touched", "UNCHECKED ", "\"Parent\" is typed Instance");
    check("LoadLibrary", "NOT FOUND ", "no class, enum, datatype, library or global named \"LoadLibrary\"");
}

#[tokio::test]
async fn engine_api_walks_the_same_expressions() {
    let ctx = no_forum();
    let (text, err) = call(&ctx, "get_engine_api", json!({ "name": "game.Players.LocalPlayer.Character" })).await;
    assert!(!err && text.starts_with("Player ") && text.contains("Character: Model"), "{text}");
    let (text, err) = call(&ctx, "get_engine_api", json!({ "name": "script.Parent.Touched" })).await;
    assert!(err && text.contains("\"Parent\" is typed Instance"), "{text}");
    let (text, err) = call(&ctx, "get_engine_api", json!({ "name": "game.Players.LocalPlayer.Character.Humanoid" })).await;
    assert!(!err && text.starts_with("\"Humanoid\" is not a member of Model: it indexes a child"), "{text}");
    assert!(text.contains("\nHumanoid (inherits Instance)") && text.contains("MoveTo(location: Vector3)"));
}

#[tokio::test]
async fn thread_shows_the_linked_reply() {
    let ctx = ctx_with(Box::new(|url| {
        if url.contains("/posts/by_number/77/33.json") {
            return Some(Ok(post(33, 3000, json!({ "cooked": "<p>the linked reply</p>" }))));
        }
        url.contains("/t/77.json").then(|| {
            Ok(json!({ "id": 77, "title": "Long thread", "posts_count": 40,
                "post_stream": { "posts": (1..=20).map(|i| post(i, 3000, json!({}))).collect::<Vec<_>>(), "stream": (3001..=3040).collect::<Vec<u64>>() } }))
        })
    }));
    let (text, _) = call(&ctx, "get_thread", json!({ "topic": "https://devforum.roblox.com/t/long-thread/77/33", "max_posts": 2 })).await;
    let a = text.find("#1 by u1").unwrap();
    let b = text.find("#33 by u33").unwrap();
    assert!(a < b && text.contains("the linked reply"), "{text}");
}

#[tokio::test]
async fn whats_new_reports_sections_that_loaded() {
    let now = format!("{}T00:00:00Z", roblox_devforum_mcp::time::today());
    let ctx = ctx_with(Box::new(move |url| {
        if url.contains("/release-notes/") || url.contains("/t/3.json") {
            return Some(Err(()));
        }
        if url.contains("/tag/weekly-recap/") {
            return Some(Ok(json!({ "topic_list": { "topics": [{ "id": 3, "title": "Weekly Recap: this week", "created_at": now }] } })));
        }
        if url.contains("/announcements/") {
            return Some(Ok(json!({ "topic_list": { "topics": [{ "id": 9, "title": "A new API", "created_at": now }] } })));
        }
        None
    }));
    let (text, err) = call(&ctx, "get_whats_new", json!({ "days": 7 })).await;
    assert!(!err, "{text}");
    assert!(text.contains("Weekly Recap: this week") && text.contains("A new API"));
    assert!(text.contains("release notes could not be loaded and is left out"), "{text}");
}

#[tokio::test]
async fn variable_rooted_paths() {
    let ctx = no_forum();
    let (text, _) = call(
        &ctx,
        "check_api_health",
        json!({ "members": ["hit.Parent.Humanoid", "plr.Character.Humanoid:MoveTo", "self.Humanoid.Health", "x.y.z"] }),
    )
    .await;
    let l = line_for(&text, "hit.Parent.Humanoid");
    assert!(l.starts_with("UNCHECKED ") && l.contains("\"hit\" is a variable"), "{l}");
    let l = line_for(&text, "plr.Character.Humanoid:MoveTo");
    assert!(l.starts_with("OK ") && l.contains("MoveTo("), "{l}");
    let l = line_for(&text, "self.Humanoid.Health");
    assert!(l.starts_with("OK ") && l.contains("Health: float"), "{l}");
    assert!(line_for(&text, "x.y.z").starts_with("UNCHECKED "));
}

#[tokio::test]
async fn docs_url_reads_as_its_page() {
    let ctx = no_forum();
    let (text, err) =
        call(&ctx, "search_creator_docs", json!({ "path": "https://create.roblox.com/docs/reference/engine/libraries/task#wait" })).await;
    assert!(!err, "{text}");
    assert!(text.starts_with("https://create.roblox.com/docs/reference/engine/libraries/task\n") && text.contains("task.wait"));
    let (text, err) = call(&ctx, "search_creator_docs", json!({ "path": "reference/engine/libraries/tsak" })).await;
    assert!(err && text.contains("No documentation page at \"reference/engine/libraries/tsak\""), "{text}");
}

#[tokio::test]
async fn timed_out_parent_search_falls_back_to_children() {
    struct Slow;
    impl Transport for Slow {
        fn get<'a>(&'a self, url: &'a str, _h: Headers, _t: Duration) -> BoxFuture<'a, Result<Response, FetchError>> {
            async move {
                if url.contains("/site.json") {
                    return ok_json(json!({ "categories": [] }));
                }
                if url.contains("%23bug-reports") || url.contains("%23scripting-support") {
                    return Err(FetchError::Timeout);
                }
                let id = url.len() as u64;
                ok_json(json!({ "topics": [{ "id": id, "title": "hit" }], "posts": [{ "id": id, "post_number": 1, "topic_id": id }] }))
            }
            .boxed()
        }
    }
    let cfg = Config { max_retries: 0, cache_dir: std::env::temp_dir().join("devforum-mcp-slow-test"), ..Config::defaults() };
    let ctx = Ctx::new(cfg, Arc::new(Slow));
    let opts = roblox_devforum_mcp::discourse::SearchOptions {
        query: "datastore".into(),
        category: Some("bug-reports".into()),
        ..Default::default()
    };
    let r = roblox_devforum_mcp::discourse::search(&ctx, &opts).await.unwrap();
    assert!(!r.topics.is_empty());
    let opts = roblox_devforum_mcp::discourse::SearchOptions { category: Some("scripting-support".into()), ..opts };
    assert!(roblox_devforum_mcp::discourse::search(&ctx, &opts).await.unwrap_err().is_timeout());
}
