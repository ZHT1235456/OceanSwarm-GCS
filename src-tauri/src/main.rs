// Release builds are GUI-only: no console window behind the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ocean_swarm_gcs_lib::run()
}
