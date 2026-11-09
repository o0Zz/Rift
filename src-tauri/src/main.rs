// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.as_slice() {
        // `rift.exe hook <harness>`: called by an agent's hook, forwards stdin to the running app and exits.
        [_, cmd, harness] if cmd == "hook" => rift_lib::hook::run_client(harness),
        // `rift.exe status <harness>`: the agent's status line command (prints a line, forwards the numbers).
        [_, cmd, harness] if cmd == "status" => rift_lib::hook::run_status(harness),
        // `rift.exe mcp`: an agent's MCP server (agent messaging), on stdin/stdout, talking to the running app.
        [_, cmd] if cmd == "mcp" => rift_lib::mcp::run_server(),
        _ => rift_lib::run(),
    }
}
