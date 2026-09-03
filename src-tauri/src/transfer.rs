use crate::{validate_id, AppError, AppState};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use axum::{
    body::Body,
    extract::{Path as AxumPath, State as AxumState},
    http::{header, HeaderValue, Response, StatusCode},
    response::{Html, IntoResponse},
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;
use url::Url;

const TRANSFER_AAD: &[u8] = b"PNE_TRANSFER_V1";
const MAX_TRANSFER_BYTES: usize = 16 * 1024 * 1024;
const MAX_CLIP_BYTES: usize = 4 * 1024 * 1024;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferClipInput {
    clip_id: String,
    slot_ids: Vec<String>,
    mime: String,
    duration_ms: u64,
    audio_bytes: Vec<u8>,
}

#[derive(Serialize)]
struct TransferManifest {
    format: &'static str,
    format_version: &'static str,
    transfer_id: String,
    work_id: String,
    release_id: String,
    work_version: String,
    content_graph_hash: String,
    created_at: String,
    clips: Vec<TransferManifestClip>,
}

#[derive(Serialize)]
struct TransferManifestClip {
    clip_id: String,
    slot_ids: Vec<String>,
    path: String,
    mime: &'static str,
    bytes: usize,
    sha256: String,
    duration_ms: u64,
}

struct TransferPayload {
    token: String,
    bytes: Vec<u8>,
    consumed: Mutex<bool>,
    expires_at_unix: u64,
    player_origin: String,
}

#[tauri::command]
pub async fn transfer_start_dev(
    state: tauri::State<'_, AppState>,
    work_id: String,
    work_version: String,
    clips: Vec<TransferClipInput>,
    player_origin: String,
) -> Result<TransferStarted, AppError> {
    validate_id(&work_id)?;
    validate_id(&work_version)?;
    if clips.is_empty() {
        return Err(AppError::new(
            "TRANSFER_NO_CLIPS",
            "転送する名前音声がありません",
        ));
    }
    let player_origin = validate_player_origin(&player_origin)?;
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let expires = now + 600;
    let envelope = build_transfer_envelope(&work_id, &work_version, clips, &key, &nonce, now)?;
    if envelope.len() > MAX_TRANSFER_BYTES {
        return Err(AppError::new(
            "TRANSFER_TOO_LARGE",
            "スマホ転送の上限16 MiBを超えています",
        ));
    }

    let payload = Arc::new(TransferPayload {
        token: token.clone(),
        bytes: envelope,
        consumed: Mutex::new(false),
        expires_at_unix: expires,
        player_origin,
    });
    let ip = private_ip().ok_or_else(|| {
        AppError::new(
            "TRANSFER_NO_PRIVATE_LAN",
            "転送に利用できるプライベートネットワークが見つかりません",
        )
    })?;
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(ip, 0))
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
    let player_origin =
        serde_json::to_string(&payload.player_origin).unwrap_or_else(|_| "\"\"".into());
    let expires_at = payload.expires_at_unix * 1000;
    let html = format!(
        r#"<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>P.N.E. 転送</title><style>body{{font-family:system-ui;background:#100918;color:#fff;max-width:520px;margin:auto;padding:40px 22px;text-align:center}}button,a{{display:block;width:100%;box-sizing:border-box;border:0;background:#df2d7f;color:#fff;padding:16px;border-radius:9px;text-decoration:none;font-weight:bold;margin:18px 0;cursor:pointer}}a{{background:#3b2650}}p{{color:#b4a8bc;line-height:1.8}}[hidden]{{display:none}}#error{{color:#ff9aab}}</style><h1>P.N.E.</h1><h2>名前音声をスマホへ</h2><p>暗号化された転送ファイルを保存してください。名前音声はP.N.E.サーバーへ送信されません。</p><button id="save">転送ファイルを保存</button><a id="next" hidden>スマホプレイヤーへ進む</a><p id="status">QRコードを読み取った端末だけが受け取れます。</p><p id="error"></p><script>const playerOrigin={player_origin};const expiresAt={expires_at};const token={token_json};const hash=new URLSearchParams(location.hash.slice(1));const key=hash.get('k');const error=document.getElementById('error');const status=document.getElementById('status');const next=document.getElementById('next');if(!key){{error.textContent='復号鍵が見つかりません。PCで新しいQRコードを作ってください。';document.getElementById('save').disabled=true;}}else{{sessionStorage.setItem('pne.transfer.key',key);history.replaceState(null,'',location.pathname);}}document.getElementById('save').addEventListener('click',async()=>{{try{{status.textContent='保存用ファイルを準備しています…';const response=await fetch('/t/'+token+'/file',{{cache:'no-store'}});if(!response.ok)throw new Error('download failed');const blob=await response.blob();const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download='PNE-transfer.pne-transfer';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent='保存できたら、次のボタンを押してください。';const savedKey=sessionStorage.getItem('pne.transfer.key');next.href=playerOrigin+'/mobile-import#k='+encodeURIComponent(savedKey)+'&e='+expiresAt;next.hidden=false;}}catch(_){{error.textContent='保存できませんでした。PCで新しいQRコードを作ってください。';}}}});</script></html>"#,
        player_origin = player_origin,
        expires_at = expires_at,
        token_json = serde_json::to_string(&token).unwrap_or_else(|_| "\"\"".into()),
    );
    let mut response = Html(html).into_response();
    secure_headers(response.headers_mut());
    response
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
        Some("attachment; filename=PNE-transfer.pne-transfer"),
    )
}

fn response(status: StatusCode, bytes: Vec<u8>, disposition: Option<&str>) -> Response<Body> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_TYPE, "application/vnd.pne.transfer")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(value) = disposition {
        builder = builder.header(header::CONTENT_DISPOSITION, value);
    }
    builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn secure_headers(headers: &mut axum::http::HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("Referrer-Policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
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

fn validate_player_origin(raw: &str) -> Result<String, AppError> {
    let url = Url::parse(raw)
        .map_err(|_| AppError::new("INVALID_PLAYER_ORIGIN", "スマホプレイヤーURLが不正です"))?;
    let local_http = url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !local_http)
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(AppError::new(
            "INVALID_PLAYER_ORIGIN",
            "スマホプレイヤーURLはHTTPS originで指定してください",
        ));
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

fn build_transfer_envelope(
    work_id: &str,
    work_version: &str,
    clips: Vec<TransferClipInput>,
    key: &[u8; 32],
    nonce: &[u8; 12],
    created_at_unix: u64,
) -> Result<Vec<u8>, AppError> {
    let archive = build_transfer_archive(work_id, work_version, clips, created_at_unix)?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::new("TRANSFER_BUILD_FAILED", "invalid encryption key"))?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: &archive,
                aad: TRANSFER_AAD,
            },
        )
        .map_err(|_| AppError::new("TRANSFER_BUILD_FAILED", "encryption failed"))?;
    let mut envelope = b"PNET\x01\x01".to_vec();
    envelope.extend_from_slice(nonce);
    envelope.extend_from_slice(&encrypted);
    Ok(envelope)
}

fn build_transfer_archive(
    work_id: &str,
    work_version: &str,
    clips: Vec<TransferClipInput>,
    created_at_unix: u64,
) -> Result<Vec<u8>, AppError> {
    let mut manifest_clips = Vec::with_capacity(clips.len());
    let mut entries = Vec::with_capacity(clips.len() + 1);
    for clip in clips {
        validate_id(&clip.clip_id)?;
        if clip.slot_ids.is_empty() {
            return Err(AppError::new(
                "TRANSFER_INVALID_CLIP",
                "slotIds is required",
            ));
        }
        for slot_id in &clip.slot_ids {
            validate_id(slot_id)?;
        }
        if clip.mime != "audio/wav"
            || clip.audio_bytes.len() < 44
            || clip.audio_bytes.len() > MAX_CLIP_BYTES
            || &clip.audio_bytes[0..4] != b"RIFF"
            || &clip.audio_bytes[8..12] != b"WAVE"
        {
            return Err(AppError::new(
                "TRANSFER_INVALID_CLIP",
                "名前音声は4 MiB以内のWAVである必要があります",
            ));
        }
        let path = format!("audio/{}.wav", clip.clip_id);
        manifest_clips.push(TransferManifestClip {
            clip_id: clip.clip_id,
            slot_ids: clip.slot_ids,
            path: path.clone(),
            mime: "audio/wav",
            bytes: clip.audio_bytes.len(),
            sha256: hex::encode(Sha256::digest(&clip.audio_bytes)),
            duration_ms: clip.duration_ms,
        });
        entries.push((path, clip.audio_bytes));
    }
    let graph_hash = hex::encode(Sha256::digest(
        format!("{work_id}\0{work_version}").as_bytes(),
    ));
    let manifest = TransferManifest {
        format: "pne-transfer",
        format_version: "1.0",
        transfer_id: uuid::Uuid::new_v4().to_string(),
        work_id: work_id.to_owned(),
        release_id: format!("dev-{work_id}-{work_version}"),
        work_version: work_version.to_owned(),
        content_graph_hash: graph_hash,
        created_at: format!("{created_at_unix}"),
        clips: manifest_clips,
    };
    let manifest_bytes = serde_json::to_vec(&manifest)
        .map_err(|error| AppError::new("TRANSFER_BUILD_FAILED", error.to_string()))?;
    entries.insert(0, ("transfer.json".to_owned(), manifest_bytes));
    build_stored_zip(entries)
}

fn build_stored_zip(entries: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, AppError> {
    if entries.len() > 257 {
        return Err(AppError::new(
            "TRANSFER_TOO_LARGE",
            "転送ファイル数が多すぎます",
        ));
    }
    let count = u16::try_from(entries.len())
        .map_err(|_| AppError::new("TRANSFER_TOO_LARGE", "ZIP entry count is too large"))?;
    let mut output = Vec::new();
    let mut central = Vec::new();
    for (name, bytes) in entries {
        let name_bytes = name.as_bytes();
        let name_len = u16::try_from(name_bytes.len())
            .map_err(|_| AppError::new("TRANSFER_BUILD_FAILED", "ZIP entry name is too long"))?;
        let size = u32::try_from(bytes.len())
            .map_err(|_| AppError::new("TRANSFER_TOO_LARGE", "ZIP entry is too large"))?;
        let offset = u32::try_from(output.len())
            .map_err(|_| AppError::new("TRANSFER_TOO_LARGE", "ZIP archive is too large"))?;
        let crc = crc32fast::hash(&bytes);

        write_u32(&mut output, 0x0403_4b50);
        write_u16(&mut output, 20);
        write_u16(&mut output, 0);
        write_u16(&mut output, 0);
        write_u16(&mut output, 0);
        write_u16(&mut output, 0);
        write_u32(&mut output, crc);
        write_u32(&mut output, size);
        write_u32(&mut output, size);
        write_u16(&mut output, name_len);
        write_u16(&mut output, 0);
        output.extend_from_slice(name_bytes);
        output.extend_from_slice(&bytes);

        write_u32(&mut central, 0x0201_4b50);
        write_u16(&mut central, 20);
        write_u16(&mut central, 20);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u32(&mut central, crc);
        write_u32(&mut central, size);
        write_u32(&mut central, size);
        write_u16(&mut central, name_len);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u32(&mut central, 0);
        write_u32(&mut central, offset);
        central.extend_from_slice(name_bytes);
    }
    let central_offset = u32::try_from(output.len())
        .map_err(|_| AppError::new("TRANSFER_TOO_LARGE", "ZIP archive is too large"))?;
    let central_size = u32::try_from(central.len())
        .map_err(|_| AppError::new("TRANSFER_TOO_LARGE", "ZIP archive is too large"))?;
    output.extend_from_slice(&central);
    write_u32(&mut output, 0x0605_4b50);
    write_u16(&mut output, 0);
    write_u16(&mut output, 0);
    write_u16(&mut output, count);
    write_u16(&mut output, count);
    write_u32(&mut output, central_size);
    write_u32(&mut output, central_offset);
    write_u16(&mut output, 0);
    Ok(output)
}

fn write_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn write_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_fixture() -> Vec<u8> {
        let mut bytes = vec![0u8; 48];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WAVE");
        bytes
    }

    #[test]
    fn envelope_contains_authenticated_zip_with_manifest_and_audio() {
        let key = [7u8; 32];
        let nonce = [9u8; 12];
        let audio = wav_fixture();
        let envelope = build_transfer_envelope(
            "rain_room",
            "1.0.0-dev",
            vec![TransferClipInput {
                clip_id: "clip-01-test".into(),
                slot_ids: vec!["name.start.whisper".into()],
                mime: "audio/wav".into(),
                duration_ms: 1,
                audio_bytes: audio.clone(),
            }],
            &key,
            &nonce,
            1,
        )
        .expect("build transfer");

        assert_eq!(&envelope[0..6], b"PNET\x01\x01");
        let cipher = Aes256Gcm::new_from_slice(&key).expect("cipher");
        let plain = cipher
            .decrypt(
                Nonce::from_slice(&envelope[6..18]),
                Payload {
                    msg: &envelope[18..],
                    aad: TRANSFER_AAD,
                },
            )
            .expect("decrypt");
        assert_eq!(&plain[0..4], &0x0403_4b50u32.to_le_bytes());
        assert!(plain.windows(13).any(|part| part == b"transfer.json"));
        assert!(plain
            .windows("audio/clip-01-test.wav".len())
            .any(|part| part == b"audio/clip-01-test.wav"));
        assert!(plain.windows(audio.len()).any(|part| part == audio));
    }

    #[test]
    fn rejects_non_https_remote_player_origin() {
        assert!(validate_player_origin("http://example.com").is_err());
        assert_eq!(
            validate_player_origin("https://player.example.com/").unwrap(),
            "https://player.example.com"
        );
    }
}
