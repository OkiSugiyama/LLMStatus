#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--collect") {
        if let Err(message) = llmstatus_lib::run_collector(args) {
            eprintln!("llmstatus collector: {message}");
            std::process::exit(2);
        }
        return;
    }
    llmstatus_lib::run();
}
