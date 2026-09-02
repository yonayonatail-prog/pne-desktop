use crate::{validate_id, AppError, AppState};
use std::path::PathBuf;
use tauri::State;

fn project_dir(state: &AppState) -> PathBuf {
    state.data_dir.join("authoring")
}

fn project_path(state: &AppState, project_id: &str) -> Result<PathBuf, AppError> {
    validate_id(project_id)?;
    Ok(project_dir(state).join(format!("{project_id}.json")))
}

#[tauri::command]
pub fn project_save(
    state: State<'_, AppState>,
    project_id: String,
    project: serde_json::Value,
) -> Result<(), AppError> {
    let path = project_path(&state, &project_id)?;
    let serialized = serde_json::to_vec_pretty(&project)
        .map_err(|error| AppError::new("AUTHORING_INVALID", error.to_string()))?;
    if serialized.len() > 16 * 1024 * 1024 {
        return Err(AppError::new("AUTHORING_TOO_LARGE", "制作パックは16 MiB以内で保存してください"));
    }
    std::fs::create_dir_all(project_dir(&state))?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, [serialized.as_slice(), b"\n"].concat())?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    std::fs::rename(temp, path)?;
    Ok(())
}

#[tauri::command]
pub fn project_load(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Option<serde_json::Value>, AppError> {
    let path = project_path(&state, &project_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let metadata = std::fs::metadata(&path)?;
    if metadata.len() > 16 * 1024 * 1024 {
        return Err(AppError::new("AUTHORING_TOO_LARGE", "制作パックは16 MiB以内で読み込んでください"));
    }
    let bytes = std::fs::read(path)?;
    let value = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::new("AUTHORING_INVALID", error.to_string()))?;
    Ok(Some(value))
}

