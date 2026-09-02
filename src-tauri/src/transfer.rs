use crate::{validate_id, AppError, AppState};
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use axum::{
    body::Body,
    extract::{Path as AxumPath, State as AxumState},
    http::{header, Response, StatusCode},
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::Serialize;
use std::{
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;

pub struct TransferControl {
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStarted {
    url: String,
    expires_at: String,
    task_id: String,
}

struct TransferPayload {
    token: String,
    bytes: Vec<u8>,
    consumed: Mutex<bool>,
    expires_at_unix: u64,
}

#[tauri::command]
pub async fn transfer_start_dev(
    state: tauri::State<'_, AppState>,
    work_id: String,
    work_version: String,
) -> Result<TransferStarted, AppError> {
    validate_id(&work_id)?;
    if work_version.len() > 64 {
        return Err(AppError::new("INVALID_VERSION", "workVersion is too long"));
    }
    {
        let transfers = state
            .transfers
            .lock()
            .map_err(|_| AppError::new("RESOURCE_BUSY", "transfer state is unavailable"))?;
        if !transfers.is_empty() {
            return Err(AppError::new("RESOURCE_BUSY", "another transfer is active"));
        }
    }
    let mut key = [0u8; 32];
    let mut nonce = [0u8; 12];
    let mut token_bytes = [0u8; 24];
    OsRng.fill_bytes(&mut key);
    OsRng.fill_bytes(&mut nonce);
    OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let plaintext = serde_json::to_vec(&serde_json::json!({
        "format": "pne-transfer", "format_version": "1.0.0", "work_id": work_id,
        "work_version": work_version, "created_by": "development-fixture", "clips": []
    }))
    .map_err(|error| AppError::new("TRANSFER_BUILD_FAILED", error.to_string()))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| AppError::new("TRANSFER_BUILD_FAILED", "invalid encryption key"))?;
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| AppError::new("TRANSFER_BUILD_FAILED", "encryption failed"))?;
    let mut envelope = b"PNE-TRANSFER\0\x01".to_vec();
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&encrypted);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expires = now + 600;
    let payload = Arc::new(TransferPayload {
        token: token.clone(),
        bytes: envelope,
        consumed: Mutex::new(false),
        expires_at_unix: expires,
    });
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(|error| AppError::new("TRANSFER_BIND_FAILED", error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::new("TRANSFER_BIND_FAILED", error.to_string()))?
        .port();
    let router = Router::new()
        .route("/t/{token}", get(landing))
        .route("/t/{token}/file", get(download).head(probe))
        .with_state(payload);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
            })
            .await;
    });
    let task_id = uuid::Uuid::new_v4().to_string();
    state
        .transfers
        .lock()
        .map_err(|_| AppError::new("RESOURCE_BUSY", "transfer state is unavailable"))?
        .insert(
            task_id.clone(),
            TransferControl {
                shutdown: Some(shutdown_tx),
            },
        );
    let ip = private_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let key_fragment = URL_SAFE_NO_PAD.encode(key);
    Ok(TransferStarted {
        url: format!("http://{ip}:{port}/t/{token}#k={key_fragment}"),
        expires_at: (expires * 1000).to_string(),
        task_id,
    })
}

#[tauri::command]
pub fn transfer_stop_dev(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<(), AppError> {
    let mut transfers = state
        .transfers
        .lock()
        .map_err(|_| AppError::new("RESOURCE_BUSY", "transfer state is unavailable"))?;
    if let Some(mut control) = transfers.remove(&task_id) {
        if let Some(shutdown) = control.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    Ok(())
}

async fn landing(
    AxumPath(token): AxumPath<String>,
    AxumState(payload): AxumState<Arc<TransferPayload>>,
) -> impl IntoResponse {
    if token != payload.token || expired(&payload) {
        return (
            StatusCode::GONE,
            Html(String::from("この転送URLは無効です")),
        )
            .into_response();
    }
    let html = format!(
        r#"<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>P.N.E. 転送</title><style>body{{font-family:system-ui;background:#100918;color:#fff;max-width:520px;margin:auto;padding:40px 22px;text-align:center}}a{{display:block;background:#df2d7f;color:#fff;padding:16px;border-radius:9px;text-decoration:none;font-weight:bold;margin:25px 0}}p{{color:#b4a8bc;line-height:1.8}}</style><h1>P.N.E.</h1><h2>暗号化ファイルを保存</h2><p>このファイルはスマホWebプレイヤーで選択するまで暗号化されています。取得は一度だけです。</p><a href="/t/{token}/file" download="story.pne-transfer">転送ファイルを保存</a><p>保存後、P.N.E.スマホWebプレイヤーを開いてファイルを選んでください。</p></html>"#
    );
    Html(html).into_response()
}

async fn probe(
    AxumPath(token): AxumPath<String>,
    AxumState(payload): AxumState<Arc<TransferPayload>>,
) -> impl IntoResponse {
    if token != payload.token || expired(&payload) {
        StatusCode::GONE
    } else {
        StatusCode::OK
    }
}

async fn download(
    AxumPath(token): AxumPath<String>,
    AxumState(payload): AxumState<Arc<TransferPayload>>,
) -> Response<Body> {
    if token != payload.token || expired(&payload) {
        return response(StatusCode::GONE, Vec::new(), None);
    }
    let Ok(mut consumed) = payload.consumed.lock() else {
        return response(StatusCode::INTERNAL_SERVER_ERROR, Vec::new(), None);
    };
    if *consumed {
        return response(StatusCode::GONE, Vec::new(), None);
    }
    *consumed = true;
    response(
        StatusCode::OK,
        payload.bytes.clone(),
        Some("attachment; filename=story.pne-transfer"),
    )
}

fn response(status: StatusCode, bytes: Vec<u8>, disposition: Option<&str>) -> Response<Body> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/octet-stream");
    if let Some(value) = disposition {
        builder = builder.header(header::CONTENT_DISPOSITION, value);
    }
    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn expired(payload: &TransferPayload) -> bool {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        > payload.expires_at_unix
}

fn private_ip() -> Option<IpAddr> {
    let ip = local_ip_address::local_ip().ok()?;
    match ip {
        IpAddr::V4(value) if value.is_private() => Some(ip),
        _ => None,
    }
}
