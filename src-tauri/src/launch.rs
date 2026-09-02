use crate::{AppError, AppState};
use serde::Serialize;
use std::{sync::atomic::Ordering, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchEvent {
    seq: u64,
    r#type: &'static str,
    work_id: String,
}

pub fn parse_work_id(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "pne"
        || url.host_str() != Some("open")
        || !matches!(url.path(), "" | "/")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 1 || pairs[0].0 != "work_id" {
        return None;
    }
    let work_id = pairs[0].1.to_string();
    let bytes = work_id.as_bytes();
    if bytes.is_empty()
        || bytes.len() > 128
        || !bytes[0].is_ascii_alphanumeric()
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return None;
    }
    Some(work_id)
}

pub fn accept_url(app: &AppHandle, raw: &str) {
    let Some(work_id) = parse_work_id(raw) else {
        return;
    };
    let state = app.state::<AppState>();
    if let Ok(mut last) = state.last_launch.lock() {
        if let Some((previous, instant)) = last.as_ref() {
            if previous == &work_id && instant.elapsed() < Duration::from_secs(2) {
                return;
            }
        }
        *last = Some((work_id.clone(), std::time::Instant::now()));
    }
    if let Ok(mut pending) = state.pending_launch.lock() {
        *pending = Some(work_id.clone());
    }
    let seq = state.event_sequence.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = app.emit(
        "pne://desktop-event",
        LaunchEvent {
            seq,
            r#type: "launch.requested",
            work_id,
        },
    );
}

pub fn configure(app: &mut tauri::App) -> Result<(), AppError> {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link()
        .register_all()
        .map_err(|error| AppError::new("DEEP_LINK_REGISTER_FAILED", error.to_string()))?;

    if let Some(urls) = app
        .deep_link()
        .get_current()
        .map_err(|error| AppError::new("DEEP_LINK_READ_FAILED", error.to_string()))?
    {
        for url in urls {
            accept_url(app.handle(), url.as_str());
        }
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            accept_url(&handle, url.as_str());
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::parse_work_id;

    #[test]
    fn accepts_only_the_canonical_contract() {
        assert_eq!(
            parse_work_id("pne://open?work_id=rain_room"),
            Some("rain_room".into())
        );
        assert_eq!(
            parse_work_id("pne://open/?work_id=a.b-1"),
            Some("a.b-1".into())
        );
        assert_eq!(parse_work_id("pne://open?work_id=x&extra=1"), None);
        assert_eq!(parse_work_id("pne://open?work_id=a&work_id=b"), None);
        assert_eq!(parse_work_id("pne://other?work_id=a"), None);
        assert_eq!(parse_work_id("pne://open?work_id=%2E%2E%2Fbad"), None);
        assert_eq!(parse_work_id("pne://open?work_id=a#key"), None);
    }
}
