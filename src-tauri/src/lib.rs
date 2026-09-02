mod launch;
mod authoring;
mod persistence;
mod transfer;

use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::AtomicU64, Mutex},
};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    code: &'static str,
    message: String,
}

impl AppError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        Self::new("IO_ERROR", value.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        Self::new("DATABASE_ERROR", value.to_string())
    }
}

pub struct AppState {
    data_dir: PathBuf,
    pending_launch: Mutex<Option<String>>,
    last_launch: Mutex<Option<(String, std::time::Instant)>>,
    event_sequence: AtomicU64,
    transfers: Mutex<HashMap<String, transfer::TransferControl>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsSnapshot {
    app_version: &'static str,
    tauri: bool,
    platform: &'static str,
    webview: &'static str,
    web_gpu: &'static str,
    microphone: &'static str,
    storage_bytes: u64,
    model_state: &'static str,
    release_configuration: &'static str,
}

#[tauri::command]
fn launch_get_pending(state: State<'_, AppState>) -> Option<String> {
    state.pending_launch.lock().ok()?.take()
}

#[tauri::command]
fn works_list() -> Result<Vec<serde_json::Value>, AppError> {
    let work = serde_json::from_str(include_str!("../fixtures/rain_room.json"))
        .map_err(|error| AppError::new("FIXTURE_INVALID", error.to_string()))?;
    Ok(vec![work])
}

#[tauri::command]
fn session_save_dev(
    state: State<'_, AppState>,
    session: serde_json::Value,
) -> Result<(), AppError> {
    let work_id = session
        .get("workId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("INVALID_SESSION", "workId is required"))?;
    let version = session
        .get("workVersion")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("INVALID_SESSION", "workVersion is required"))?;
    validate_id(work_id)?;
    if version.len() > 64 {
        return Err(AppError::new("INVALID_SESSION", "workVersion is too long"));
    }
    persistence::save_session(&state.data_dir, work_id, version, &session)
}

#[tauri::command]
fn session_load_dev(
    state: State<'_, AppState>,
    work_id: String,
    work_version: String,
) -> Result<Option<serde_json::Value>, AppError> {
    validate_id(&work_id)?;
    persistence::load_session(&state.data_dir, &work_id, &work_version)
}

#[tauri::command]
fn session_delete_dev(
    state: State<'_, AppState>,
    work_id: String,
    work_version: String,
) -> Result<(), AppError> {
    validate_id(&work_id)?;
    persistence::delete_session(&state.data_dir, &work_id, &work_version)
}

#[tauri::command]
fn diagnostics_snapshot(state: State<'_, AppState>) -> DiagnosticsSnapshot {
    DiagnosticsSnapshot {
        app_version: env!("CARGO_PKG_VERSION"),
        tauri: true,
        platform: std::env::consts::OS,
        webview: "WebView2",
        web_gpu: "available",
        microphone: "unchecked",
        storage_bytes: directory_size(&state.data_dir),
        model_state: "NOT_INSTALLED",
        release_configuration: if option_env!("PNE_RELEASE_CONFIGURED") == Some("1") {
            "PRODUCTION"
        } else {
            "DEVELOPMENT"
        },
    }
}

#[tauri::command]
fn portal_open(app: tauri::AppHandle, target: String) -> Result<(), AppError> {
    if target != "HOME" {
        return Err(AppError::new(
            "INVALID_PORTAL_TARGET",
            "Only HOME is available in this build",
        ));
    }
    let origin = option_env!("PNE_PORTAL_ORIGIN").unwrap_or("https://pne.example.invalid");
    app.opener()
        .open_url(origin, None::<&str>)
        .map_err(|error| AppError::new("PORTAL_OPEN_FAILED", error.to_string()))
}

fn validate_id(value: &str) -> Result<(), AppError> {
    let bytes = value.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 128
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(AppError::new(
            "INVALID_ID",
            "ID does not match the P.N.E. identifier contract",
        ));
    }
    Ok(())
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let Ok(metadata) = entry.metadata() else {
                return 0;
            };
            if metadata.is_dir() {
                directory_size(&entry.path())
            } else {
                metadata.len()
            }
        })
        .sum()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for argument in argv {
                launch::accept_url(app, &argument);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            persistence::migrate(&data_dir)?;
            app.manage(AppState {
                data_dir,
                pending_launch: Mutex::new(None),
                last_launch: Mutex::new(None),
                event_sequence: AtomicU64::new(0),
                transfers: Mutex::new(HashMap::new()),
            });
            launch::configure(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            launch_get_pending,
            works_list,
            session_save_dev,
            session_load_dev,
            session_delete_dev,
            diagnostics_snapshot,
            portal_open,
            transfer::transfer_start_dev,
            transfer::transfer_stop_dev,
            authoring::project_save,
            authoring::project_load
        ])
        .run(tauri::generate_context!())
        .expect("failed to run P.N.E. desktop player");
}
