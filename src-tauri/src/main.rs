// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `rift.exe hook <harness>`: called by an agent's hook, forwards stdin to the running app and exits.
    if let [_, cmd, harness] = args.as_slice()
        && cmd == "hook"
    {
        return rift_lib::hook::run_client(harness);
    }
    rift_lib::run()
}
