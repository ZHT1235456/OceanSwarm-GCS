//! OceanSwarm GCS desktop shell.
//!
//! The whole console is a static Vite build embedded into the binary and served
//! through Tauri's custom protocol; no Rust-side commands are needed.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running OceanSwarm GCS");
}
