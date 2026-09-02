use crate::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

fn database_path(data_dir: &Path) -> PathBuf {
    data_dir.join("pne.sqlite3")
}

fn connection(data_dir: &Path) -> Result<Connection, AppError> {
    let connection = Connection::open(database_path(data_dir))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(connection)
}

pub fn migrate(data_dir: &Path) -> Result<(), AppError> {
    let mut connection = connection(data_dir)?;
    let transaction = connection.transaction()?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL,
            work_version TEXT NOT NULL,
            state_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('IN_PROGRESS','COMPLETED')),
            revision INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS one_dev_session_per_release ON sessions(work_id, work_version);
        CREATE TABLE IF NOT EXISTS session_operations (
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            operation_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('NODE_COMMIT','GATE_ADVANCE')),
            applied_revision INTEGER NOT NULL,
            proposal_sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(session_id, operation_id)
        );
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);"
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn save_session(
    data_dir: &Path,
    work_id: &str,
    work_version: &str,
    session: &serde_json::Value,
) -> Result<(), AppError> {
    let session_id = session
        .pointer("/snapshot/sessionId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AppError::new("INVALID_SESSION", "snapshot.sessionId is required"))?;
    let revision = session
        .pointer("/snapshot/revision")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| AppError::new("INVALID_SESSION", "snapshot.revision is required"))?;
    let status = if session
        .pointer("/snapshot/status")
        .and_then(|value| value.as_str())
        == Some("ENDED")
    {
        "COMPLETED"
    } else {
        "IN_PROGRESS"
    };
    let updated_at = session
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let state_json = serde_json::to_string(session)
        .map_err(|error| AppError::new("INVALID_SESSION", error.to_string()))?;
    if state_json.len() > 8 * 1024 * 1024 {
        return Err(AppError::new(
            "INVALID_SESSION",
            "session exceeds the 8 MiB limit",
        ));
    }
    let connection = connection(data_dir)?;
    connection.execute(
        "INSERT INTO sessions(session_id, work_id, work_version, state_json, status, revision, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(work_id, work_version) DO UPDATE SET
           session_id=excluded.session_id, state_json=excluded.state_json, status=excluded.status,
           revision=excluded.revision, updated_at=excluded.updated_at
         WHERE excluded.revision >= sessions.revision",
        params![session_id, work_id, work_version, state_json, status, revision, updated_at]
    )?;
    Ok(())
}

pub fn load_session(
    data_dir: &Path,
    work_id: &str,
    work_version: &str,
) -> Result<Option<serde_json::Value>, AppError> {
    let connection = connection(data_dir)?;
    let raw: Option<String> = connection.query_row(
        "SELECT state_json FROM sessions WHERE work_id=?1 AND work_version=?2 ORDER BY updated_at DESC LIMIT 1",
        params![work_id, work_version], |row| row.get(0)
    ).optional()?;
    raw.map(|value| {
        serde_json::from_str(&value)
            .map_err(|error| AppError::new("SAVE_INCOMPATIBLE", error.to_string()))
    })
    .transpose()
}

pub fn delete_session(data_dir: &Path, work_id: &str, work_version: &str) -> Result<(), AppError> {
    let connection = connection(data_dir)?;
    connection.execute(
        "DELETE FROM sessions WHERE work_id=?1 AND work_version=?2",
        params![work_id, work_version],
    )?;
    Ok(())
}
