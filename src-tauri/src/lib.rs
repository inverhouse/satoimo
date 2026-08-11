mod audio;
mod events;
mod export;
mod model;
mod project;
mod recovery;
mod timeline;

use events::{EventWriter, SharedWriter};
use model::*;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    AppHandle, State,
};

#[derive(Clone, Default)]
struct AppState {
    media: Arc<Mutex<HashMap<String, PathBuf>>>,
    events: SharedWriter,
    audio: Arc<Mutex<Option<audio::AudioCapture>>>,
    session_project: Arc<Mutex<Option<PathBuf>>>,
    export: export::ExportState,
}

fn decorate(mut project: Project, state: &AppState) -> Result<Project, String> {
    let source = if project.proxy.status == "ready" {
        project
            .proxy
            .relative_path
            .as_ref()
            .map(|p| Path::new(&project.project_path).join(p))
            .unwrap_or_else(|| PathBuf::from(&project.source.absolute_path))
    } else {
        PathBuf::from(&project.source.absolute_path)
    };
    let canonical = source.canonicalize().map_err(|_| {
        "SOURCE_MISSING: 元動画が見つかりません。再リンクしてください。".to_string()
    })?;
    let token = uuid::Uuid::new_v4().to_string();
    state.media.lock().insert(token.clone(), canonical);
    project.media_url = format!("media://localhost/{token}");
    project.audio_url.clear();
    if let Some(take) = &project.take {
        let audio = Path::new(&project.project_path)
            .join(&take.audio_path)
            .canonicalize()
            .map_err(|_| "収録音声が見つかりません。復旧画面から確認してください。".to_string())?;
        let audio_token = uuid::Uuid::new_v4().to_string();
        state.media.lock().insert(audio_token.clone(), audio);
        project.audio_url = format!("media://localhost/{audio_token}");
    }
    Ok(project)
}

#[tauri::command]
fn create_project(
    source_path: String,
    parent_path: String,
    name: String,
    state: State<AppState>,
) -> Result<Project, String> {
    decorate(
        project::create(Path::new(&source_path), Path::new(&parent_path), &name)?,
        &state,
    )
}
#[tauri::command]
fn open_project(project_path: String, state: State<AppState>) -> Result<Project, String> {
    decorate(project::load(Path::new(&project_path))?, &state)
}
#[tauri::command]
fn save_project(project: Project) -> Result<(), String> {
    project::save(&project)
}
#[tauri::command]
fn recent_projects() -> Result<Vec<Project>, String> {
    project::recent()
}
#[tauri::command]
fn recovery_candidates() -> Result<Vec<RecoveryCandidate>, String> {
    recovery::candidates()
}
#[tauri::command]
fn recover_take(project_path: String, state: State<AppState>) -> Result<Project, String> {
    decorate(recovery::recover(Path::new(&project_path))?, &state)
}
#[tauri::command]
fn discard_recovery(project_path: String, state: State<AppState>) -> Result<Project, String> {
    decorate(recovery::discard(Path::new(&project_path))?, &state)
}
#[tauri::command]
fn input_devices() -> Result<Vec<InputDevice>, String> {
    audio::devices()
}

#[tauri::command]
fn start_session(
    project_path: String,
    device_id: String,
    source_us: u64,
    rate: f64,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    if state.events.lock().is_some() {
        return Err("既に収録中です。".into());
    }
    let root = PathBuf::from(&project_path);
    let project = project::load(&root)?;
    if source_us > project.source.duration_us {
        return Err("開始位置が動画範囲外です。".into());
    }
    let required = 48_000u64 * 2 * 2 * 60 * 30 + 10 * 1024 * 1024;
    let free = fs2::available_space(&root).map_err(|e| format!("空き容量を確認できません: {e}"))?;
    if free < required {
        return Err(format!(
            "DISK_LOW: 収録には約{}MB必要ですが、空き容量は約{}MBです。",
            required / 1_048_576,
            free / 1_048_576
        ));
    }
    let (capture, audio_format) = audio::start(&root, &device_id, app)?;
    let writer = EventWriter::start(
        &root,
        source_us,
        rate,
        serde_json::to_value(&project.mix).unwrap_or(Value::Null),
        audio_format,
    )?;
    *state.audio.lock() = Some(capture);
    *state.events.lock() = Some(writer);
    *state.session_project.lock() = Some(root);
    Ok(())
}

#[tauri::command]
fn append_session_event(
    event_type: String,
    payload: Value,
    source_duration_us: u64,
    state: State<AppState>,
) -> Result<SessionEvent, String> {
    state
        .events
        .lock()
        .as_mut()
        .ok_or_else(|| "収録が開始されていません。".to_string())?
        .append(&event_type, payload, source_duration_us)
}

#[tauri::command]
fn stop_session(source_us: u64, playing: bool, state: State<AppState>) -> Result<Project, String> {
    let root = state
        .session_project
        .lock()
        .take()
        .ok_or_else(|| "収録が開始されていません。".to_string())?;
    let audio = state
        .audio
        .lock()
        .take()
        .ok_or_else(|| "音声収録がありません。".to_string())?;
    let writer = state
        .events
        .lock()
        .take()
        .ok_or_else(|| "イベント収録がありません。".to_string())?;
    let audio_path = match audio.finish() {
        Ok(path) => path,
        Err(error) => {
            let mut writer = writer;
            let _ = writer.append(
                "interruption",
                json!({"reason":"audio_failure"}),
                source_us.max(1),
            );
            return Err(error);
        }
    };
    let (duration_us, event_path) = writer.stop(source_us, playing)?;
    let mut project = project::load(&root)?;
    project.last_source_position_us = source_us;
    project.take = Some(TakeInfo {
        id: uuid::Uuid::new_v4().to_string(),
        duration_us,
        events_path: event_path
            .strip_prefix(&root)
            .unwrap_or(&event_path)
            .to_string_lossy()
            .into_owned(),
        audio_path: audio_path
            .strip_prefix(&root)
            .unwrap_or(&audio_path)
            .to_string_lossy()
            .into_owned(),
        recovered: false,
    });
    project::save(&project)?;
    decorate(project, &state)
}

#[tauri::command]
fn interrupt_session(
    reason: String,
    source_us: u64,
    state: State<AppState>,
) -> Result<Project, String> {
    let root = state
        .session_project
        .lock()
        .take()
        .ok_or("収録が開始されていません。")?;
    let audio = state.audio.lock().take().ok_or("音声収録がありません。")?;
    let writer = state
        .events
        .lock()
        .take()
        .ok_or("イベント収録がありません。")?;
    let audio_path = audio.finish()?;
    let (duration_us, event_path) = writer.interrupt(source_us, &reason)?;
    let mut project = project::load(&root)?;
    project.last_source_position_us = source_us;
    project.take = Some(TakeInfo {
        id: uuid::Uuid::new_v4().to_string(),
        duration_us,
        events_path: event_path
            .strip_prefix(&root)
            .unwrap_or(&event_path)
            .to_string_lossy()
            .into_owned(),
        audio_path: audio_path
            .strip_prefix(&root)
            .unwrap_or(&audio_path)
            .to_string_lossy()
            .into_owned(),
        recovered: true,
    });
    project::save(&project)?;
    decorate(project, &state)
}

#[tauri::command]
fn load_events(project_path: String) -> Result<Vec<SessionEvent>, String> {
    let project = project::load(Path::new(&project_path))?;
    let take = project.take.ok_or("収録データがありません。")?;
    events::read_valid(&Path::new(&project_path).join(take.events_path), false)
}
#[tauri::command]
fn abandon_take(project_path: String, state: State<AppState>) -> Result<Project, String> {
    decorate(recovery::archive_take(Path::new(&project_path))?, &state)
}

#[tauri::command]
async fn export_video(
    project_path: String,
    output_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = PathBuf::from(&output_path);
    let project = project::load(Path::new(&project_path))?;
    let duration = project.take.as_ref().map(|t| t.duration_us).unwrap_or(0);
    let required = ((8_192_000f64 / 8.0) * (duration as f64 / 1e6) * 1.2) as u64;
    let parent = path.parent().ok_or("保存先が不正です。")?;
    if fs2::available_space(parent).map_err(|e| e.to_string())? < required {
        return Err(format!(
            "DISK_LOW: 書き出しには約{}MB必要です。",
            required / 1_048_576
        ));
    }
    let app = app.clone();
    let export_state = state.export.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export::run(Path::new(&project_path), &path, &app, &export_state)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn cancel_export(state: State<AppState>) -> Result<(), String> {
    export::cancel(&state.export)
}

#[tauri::command]
async fn create_proxy(
    project_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Project, String> {
    let app = app.clone();
    let export_state = state.export.clone();
    let root = project_path.clone();
    let project = tauri::async_runtime::spawn_blocking(move || {
        export::run_proxy(Path::new(&root), &app, &export_state)
    })
    .await
    .map_err(|e| e.to_string())??;
    decorate(project, &state)
}
#[tauri::command]
fn cancel_proxy(state: State<AppState>) -> Result<(), String> {
    export::cancel(&state.export)
}

fn media_response(
    request: Request<Vec<u8>>,
    media: &Arc<Mutex<HashMap<String, PathBuf>>>,
) -> Response<Vec<u8>> {
    let reject = |status: StatusCode, message: &str| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(message.as_bytes().to_vec())
            .unwrap()
    };
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return reject(
            StatusCode::METHOD_NOT_ALLOWED,
            "GETまたはHEADのみ利用できます。",
        );
    }
    let token = request.uri().path().trim_start_matches('/');
    if token.contains('/') || token.contains("..") || token.is_empty() {
        return reject(StatusCode::BAD_REQUEST, "不正なmedia tokenです。");
    }
    let path = match media.lock().get(token).cloned() {
        Some(p) => p,
        None => return reject(StatusCode::NOT_FOUND, "未登録のmedia tokenです。"),
    };
    let canonical = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return reject(StatusCode::NOT_FOUND, "動画が見つかりません。"),
    };
    if canonical != path {
        return reject(StatusCode::FORBIDDEN, "media pathが変更されています。");
    }
    let mut file = match File::open(&canonical) {
        Ok(f) => f,
        Err(_) => return reject(StatusCode::NOT_FOUND, "動画を開けません。"),
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => {
            return reject(
                StatusCode::INTERNAL_SERVER_ERROR,
                "動画サイズを取得できません。",
            )
        }
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    if range.is_some_and(|v| v.contains(',')) {
        return reject(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "複数Rangeは利用できません。",
        );
    }
    let (start, end, status) = match parse_range(range, len) {
        Ok(Some((s, e))) => (s, e, StatusCode::PARTIAL_CONTENT),
        Ok(None) => (0, len.saturating_sub(1), StatusCode::OK),
        Err(_) => return reject(StatusCode::RANGE_NOT_SATISFIABLE, "Rangeが不正です。"),
    };
    let size = end.saturating_sub(start) + 1;
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, size.to_string())
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(&canonical)
                .first_or_octet_stream()
                .to_string(),
        );
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    if request.method() == Method::HEAD {
        return builder.body(Vec::new()).unwrap();
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return reject(StatusCode::INTERNAL_SERVER_ERROR, "seekに失敗しました。");
    }
    let mut data = vec![0; size as usize];
    if file.read_exact(&mut data).is_err() {
        return reject(StatusCode::INTERNAL_SERVER_ERROR, "動画を読み込めません。");
    }
    builder.body(data).unwrap()
}

fn parse_range(value: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = value else { return Ok(None) };
    let raw = value.strip_prefix("bytes=").ok_or(())?;
    let (a, b) = raw.split_once('-').ok_or(())?;
    if a.is_empty() {
        let suffix = b.parse::<u64>().map_err(|_| ())?.min(len);
        return Ok(Some((len - suffix, len - 1)));
    }
    let start = a.parse::<u64>().map_err(|_| ())?;
    let end = if b.is_empty() {
        len - 1
    } else {
        b.parse::<u64>().map_err(|_| ())?.min(len - 1)
    };
    if start > end || start >= len {
        return Err(());
    }
    Ok(Some((start, end)))
}

pub fn run() {
    let state = AppState::default();
    let media = state.media.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .register_uri_scheme_protocol("media", move |_context, request| {
            media_response(request, &media)
        })
        .invoke_handler(tauri::generate_handler![
            create_project,
            open_project,
            save_project,
            recent_projects,
            recovery_candidates,
            recover_take,
            discard_recovery,
            input_devices,
            start_session,
            append_session_event,
            stop_session,
            interrupt_session,
            load_events,
            abandon_take,
            export_video,
            cancel_export,
            create_proxy,
            cancel_proxy
        ])
        .run(tauri::generate_context!())
        .expect("さといもの起動に失敗しました");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn single_ranges_are_parsed() {
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Ok(Some((10, 19))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert!(parse_range(Some("bytes=99-10"), 100).is_err());
    }
}
