//! Agent messaging. `rift mcp` is an MCP server (stdio, one JSON-RPC message per line) that an agent starts
//! as a child. Each tool call goes to the Rift instance named in RIFT_PIPE, on its own channel
//! (`<pipe>-mcp`), tagged with the caller's tab; the frontend answers (it owns the tabs) and the answer
//! comes back on the same connection. Outside Rift every call answers that Rift is not there.

use std::future::Future;
use std::io::{BufRead, BufReader, Write};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::hook::transport;
use crate::pty::TabId;

/// A tool call, as Rift receives it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub tab: TabId,
    pub tool: String,
    pub args: Value,
}

/// The answer shown to the calling agent; `ok: false` = a tool error it can read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    pub text: String,
}

impl Reply {
    pub fn error(text: impl Into<String>) -> Self {
        Reply {
            ok: false,
            text: text.into(),
        }
    }
}

const PROTOCOL: &str = "2025-06-18";

const INSTRUCTIONS: &str = "Rift is the terminal running you, with other coding agents in other tabs. \
list_agents shows them; send_message talks to one (it receives your message as its next prompt, once idle); \
start_agent opens a new tab with an agent working on a task you give it. Answers never come back as tool \
results: they arrive later as a new prompt in your own terminal, headed with the sender's name and id.";

/// The tools every agent sees.
pub fn tools() -> Value {
    json!([
        {
            "name": "list_agents",
            "description": "List the coding agents running in Rift tabs: id, name, agent, status (idle, working, done, blocked), folder. Your own tab is marked \"you\".",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "send_message",
            "description": "Send a message to another agent in Rift (an id from list_agents). Rift types it into that agent's terminal as its next prompt as soon as it is idle (never mid-turn), with your name and id so it can answer you with send_message. Its answer does not come back here: it arrives later as a new prompt in your terminal.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": { "type": "integer", "description": "The receiving agent's id (list_agents)." },
                    "message": { "type": "string", "description": "What to tell or ask it. Self-contained: it does not see your conversation." }
                },
                "required": ["to", "message"]
            }
        },
        {
            "name": "start_agent",
            "description": "Open a new Rift tab running a coding agent and give it `prompt` as its first task. The tab opens next to yours, in your group; the user sees it. Returns the new agent's id; it can answer you with send_message. At most 5 per agent, and agents started this way cannot start others.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "The task. Self-contained: the new agent knows nothing else." },
                    "agent": { "type": "string", "description": "Which agent to run: claude, codex, gemini or copilot. Default: the same as you." },
                    "cwd": { "type": "string", "description": "Folder to work in (absolute path). Default: your folder." },
                    "name": { "type": "string", "description": "Tab name shown to the user." },
                    "worktree": { "type": "string", "description": "Work on a new git branch with this name, in its own worktree next to your repository (parallel work without conflicts)." }
                },
                "required": ["prompt"]
            }
        }
    ])
}

/// The answer to one message from the agent; `None` for notifications (no id). Tool calls go to `call`.
pub fn answer(msg: &Value, call: &mut impl FnMut(&str, Value) -> Reply) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let result = match msg["method"].as_str().unwrap_or_default() {
        "initialize" => json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "rift", "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }),
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or_default();
            let args = msg["params"]["arguments"].clone();
            let reply = call(name, args);
            json!({ "content": [{ "type": "text", "text": reply.text }], "isError": !reply.ok })
        }
        other => {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32601, "message": format!("unknown method {other}") },
            }));
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// Entry point of `rift mcp`: serves the agent on stdin/stdout until it closes stdin.
pub fn run_server() {
    let mut out = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(reply) = answer(&msg, &mut forward) {
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        }
    }
}

fn forward(tool: &str, args: Value) -> Reply {
    let (Ok(tab), Ok(pipe)) = (std::env::var("RIFT_TAB_ID"), std::env::var("RIFT_PIPE")) else {
        return Reply::error("Not running inside Rift: agent messaging works only in a Rift tab.");
    };
    let Ok(tab) = tab.parse() else {
        return Reply::error("RIFT_TAB_ID is not a tab id.");
    };
    let req = Request {
        tab,
        tool: tool.into(),
        args,
    };
    call(&channel(&pipe), &req)
        .unwrap_or_else(|e| Reply::error(format!("Rift did not answer: {e}")))
}

/// The channel MCP calls use next to the hook pipe `pipe`.
pub fn channel(pipe: &str) -> String {
    format!("{pipe}-mcp")
}

/// Sends `req` to the Rift instance listening on `name` and waits for its answer.
pub fn call(name: &str, req: &Request) -> std::io::Result<Reply> {
    let mut conn = connect(name)?;
    let mut line = serde_json::to_vec(req)?;
    line.push(b'\n');
    conn.write_all(&line)?;
    let mut answer = String::new();
    BufReader::new(conn).read_line(&mut answer)?;
    serde_json::from_str(&answer).map_err(std::io::Error::other)
}

fn connect(name: &str) -> std::io::Result<impl std::io::Read + std::io::Write> {
    // The server re-arms its pipe right after each connection; retry briefly if it is busy.
    for _ in 0..50 {
        if let Ok(conn) = transport::connect(name) {
            return Ok(conn);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err(std::io::ErrorKind::TimedOut.into())
}

/// Accepts MCP calls forever. Unlike hooks they run side by side: a call waits for the frontend, and must
/// hold up neither the others nor the hooks (their own pipe).
pub async fn serve<F, Fut>(name: String, handle: F) -> std::io::Result<()>
where
    F: Fn(Request) -> Fut + Clone + Send + 'static,
    Fut: Future<Output = Reply> + Send,
{
    let mut listener = transport::Listener::bind(&name)?;
    loop {
        let conn = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("rift: MCP connection failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let handle = handle.clone();
        tokio::spawn(async move {
            let _ = exchange(conn, handle).await;
        });
    }
}

async fn exchange<C, F, Fut>(mut conn: C, handle: F) -> std::io::Result<()>
where
    C: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    F: Fn(Request) -> Fut,
    Fut: Future<Output = Reply>,
{
    let mut line = String::new();
    // The client writes its line at once: one that hangs is dropped.
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::io::BufReader::new(&mut conn).read_line(&mut line),
    )
    .await
    .map_err(|_| std::io::ErrorKind::TimedOut)??;
    let reply = match serde_json::from_str(&line) {
        Ok(req) => handle(req).await,
        Err(e) => Reply::error(format!("bad request: {e}")),
    };
    let mut out = serde_json::to_vec(&reply)?;
    out.push(b'\n');
    conn.write_all(&out).await?;
    conn.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo(tool: &str, args: Value) -> Reply {
        Reply {
            ok: tool != "fail",
            text: format!("{tool} {args}"),
        }
    }

    #[test]
    fn speaks_mcp() {
        let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } });
        let r = answer(&init, &mut echo).unwrap();
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(r["result"]["serverInfo"]["name"], "rift");

        let list = json!({ "jsonrpc": "2.0", "id": "a", "method": "tools/list" });
        let names: Vec<_> = answer(&list, &mut echo).unwrap()["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["list_agents", "send_message", "start_agent"]);

        let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "send_message", "arguments": { "to": 3 } } });
        let r = answer(&call, &mut echo).unwrap();
        assert_eq!(
            r["result"]["content"][0]["text"],
            r#"send_message {"to":3}"#
        );
        assert_eq!(r["result"]["isError"], false);
        let fail = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "fail" } });
        assert_eq!(answer(&fail, &mut echo).unwrap()["result"]["isError"], true);
    }

    #[test]
    fn ignores_notifications_and_refuses_unknown_methods() {
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(answer(&note, &mut echo).is_none());
        let r = answer(
            &json!({ "jsonrpc": "2.0", "id": 9, "method": "resources/list" }),
            &mut echo,
        )
        .unwrap();
        assert_eq!(r["error"]["code"], -32601);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn calls_reach_rift_and_come_back_side_by_side() {
        let name = format!("rift-mcp-test-{}", std::process::id());
        // The first call is answered last: calls must not wait for each other.
        tokio::spawn(serve(name.clone(), |req: Request| async move {
            if req.tool == "slow" {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Reply {
                ok: true,
                text: format!("{} from {}", req.tool, req.tab),
            }
        }));
        tokio::time::sleep(Duration::from_millis(100)).await;

        let started = std::time::Instant::now();
        let calls = [("slow", 1), ("fast", 2)].map(|(tool, tab)| {
            let name = name.clone();
            tokio::task::spawn_blocking(move || {
                let req = Request {
                    tab,
                    tool: tool.into(),
                    args: json!({}),
                };
                (call(&name, &req).unwrap(), started.elapsed())
            })
        });
        let [slow, fast] = calls;
        let (fast, fast_at) = fast.await.unwrap();
        let (slow, _) = slow.await.unwrap();
        assert_eq!(fast.text, "fast from 2");
        assert_eq!(slow.text, "slow from 1");
        assert!(fast_at < Duration::from_millis(400), "{fast_at:?}");
    }

    #[test]
    fn outside_rift_every_call_says_so() {
        if std::env::var_os("RIFT_PIPE").is_some() {
            return; // the test runs in a Rift tab
        }
        assert!(!forward("list_agents", json!({})).ok);
    }
}
