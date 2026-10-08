mod audio;
mod export;
mod ff;

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct AppState {
    mic: Mutex<Option<audio::Mic>>,
    export_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

type R<T> = Result<T, String>;

fn data_dir(app: &AppHandle) -> PathBuf {
    let d = app.path().app_data_dir().expect("app data dir");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn sessions_dir(app: &AppHandle) -> PathBuf {
    let d = data_dir(app).join("sessions");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Only paths inside our own data dir may be written/deleted from the frontend.
fn inside_data(app: &AppHandle, p: &Path) -> R<PathBuf> {
    let base = data_dir(app);
    if p.is_absolute() && p.starts_with(&base) && !p.components().any(|c| c == std::path::Component::ParentDir) {
        Ok(p.to_path_buf())
    } else {
        Err("不正なパスです".into())
    }
}

fn audio_segments(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<(u32, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().strip_prefix("audio_")?.strip_suffix(".wav")?.parse().ok()?;
            Some((n, e.path()))
        })
        .collect();
    v.sort();
    v.into_iter().map(|x| x.1).collect()
}

#[tauri::command]
fn probe_video(app: AppHandle, path: String) -> R<ff::Probe> {
    let _ = app.asset_protocol_scope().allow_file(&path);
    ff::probe(&path)
}

/// Lightweight 720p/30fps working copy for sources the WebView can't play smoothly.
#[tauri::command]
async fn make_proxy(app: AppHandle, path: String, duration: f64, color_tagged: bool) -> R<String> {
    let out = data_dir(&app).join("cache");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let out = out.join("proxy.mp4");
    let enc = ff::h264_encoder();
    let mut c = ff::cmd();
    c.args(["-y", "-i", &path]).args(enc.args(&format!("{}scale=-2:'min(720,ih)',fps=30,", if color_tagged { "" } else { ff::ASSUME_709 })));
    c.args(["-b:v", "3M", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-progress", "pipe:1"]).arg(&out);
    let mut child = c.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
            let _ = app.emit("proxy-progress", (us / 1e6 / duration.max(1.0)).min(1.0));
        }
    }
    if !child.wait().map_err(|e| e.to_string())?.success() {
        return Err("作業用動画を作成できませんでした".into());
    }
    let s = out.to_string_lossy().to_string();
    let _ = app.asset_protocol_scope().allow_file(&s);
    Ok(s)
}

#[tauri::command]
fn mic_list() -> Vec<audio::MicInfo> {
    audio::list()
}

#[tauri::command]
fn mic_open(state: State<AppState>, id: Option<String>) -> R<String> {
    let mut g = state.mic.lock().unwrap();
    *g = None; // release the previous device first
    let m = audio::Mic::open(id)?;
    let name = m.name.clone();
    *g = Some(m);
    Ok(name)
}

#[tauri::command]
fn mic_level(state: State<AppState>) -> (f32, Option<String>) {
    state.mic.lock().unwrap().as_ref().map_or((0.0, None), |m| m.level())
}

#[tauri::command]
fn mic_close(state: State<AppState>) {
    *state.mic.lock().unwrap() = None;
}

#[tauri::command]
fn session_create(app: AppHandle, meta: String) -> R<String> {
    let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
    let d = sessions_dir(&app).join(id.to_string());
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    std::fs::write(d.join("meta.json"), meta).map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().into())
}

#[tauri::command]
fn rec_start(app: AppHandle, state: State<AppState>, dir: String) -> R<()> {
    let dir = inside_data(&app, Path::new(&dir))?;
    let g = state.mic.lock().unwrap();
    let mic = g.as_ref().ok_or("マイクが使用できません。マイクの接続と設定を確認してください。")?;
    if let Some(f) = mic.fault() {
        return Err(format!("{f}。マイクを選び直してください。"));
    }
    mic.start(&dir.join(format!("audio_{}.wav", audio_segments(&dir).len())))
}

#[tauri::command]
fn rec_stop(state: State<AppState>) -> R<f64> {
    state.mic.lock().unwrap().as_ref().map_or(Ok(0.0), |m| m.stop())
}

#[tauri::command]
fn session_append(app: AppHandle, dir: String, text: String) -> R<()> {
    let dir = inside_data(&app, Path::new(&dir))?;
    let path = dir.join("events.jsonl");
    drop_partial_line(&path).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_data().map_err(|e| e.to_string())
}

/// A crash can leave a half-written last line; cut it so the next append starts on a fresh line.
fn drop_partial_line(path: &Path) -> std::io::Result<()> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::OpenOptions::new().read(true).write(true).open(path) else { return Ok(()) };
    let len = f.metadata()?.len();
    let mut tail = vec![0u8; len.min(64 * 1024) as usize];
    let start = len - tail.len() as u64;
    f.seek(SeekFrom::Start(start))?;
    f.read_exact(&mut tail)?;
    if tail.last().is_none_or(|&b| b == b'\n') {
        return Ok(());
    }
    f.set_len(tail.iter().rposition(|&b| b == b'\n').map_or(0, |i| start + i as u64 + 1))?;
    f.sync_data()
}

/// Replaces the event log atomically (used to drop events past the recovered audio before resuming).
#[tauri::command]
fn session_rewrite(app: AppHandle, dir: String, text: String) -> R<()> {
    let dir = inside_data(&app, Path::new(&dir))?;
    let tmp = dir.join("events.jsonl.tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).and_then(|_| f.sync_data()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, dir.join("events.jsonl")).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Found {
    dir: String,
    meta: String,
    events: String,
    audio: f64,
    error: Option<String>,
}

fn audio_len(dir: &Path) -> R<f64> {
    audio_segments(dir).iter().map(|p| audio::repair_wav(p)).sum()
}

/// The newest leftover session = work interrupted by an abnormal exit.
#[tauri::command]
fn session_find(app: AppHandle) -> Option<Found> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(sessions_dir(&app)).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    let dir = dirs.pop()?;
    let meta = std::fs::read_to_string(dir.join("meta.json")).unwrap_or_default();
    let events = std::fs::read_to_string(dir.join("events.jsonl")).unwrap_or_default();
    let (audio, mut error) = match audio_len(&dir) {
        Ok(a) => (a, None),
        Err(e) => (0.0, Some(e)),
    };
    if error.is_none() && (meta.is_empty() || events.is_empty() || audio < 0.5) {
        error = Some("記録済みの音声または操作記録が見つかりません".into());
    }
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    // after a restart the source video (and its working copy) must be readable again
    if let Ok(m) = serde_json::from_str::<serde_json::Value>(&meta) {
        for k in ["path", "playPath"] {
            if let Some(p) = m["video"][k].as_str() {
                let _ = app.asset_protocol_scope().allow_file(p);
            }
        }
    }
    Some(Found { dir: dir.to_string_lossy().into(), meta, events, audio, error })
}

#[tauri::command]
fn session_audio_len(app: AppHandle, dir: String) -> R<f64> {
    audio_len(&inside_data(&app, Path::new(&dir))?)
}

/// Joins the recorded WAV segments (one per resume) into commentary.wav.
#[tauri::command]
async fn session_finalize(app: AppHandle, dir: String) -> R<(String, f64)> {
    let dir = inside_data(&app, Path::new(&dir))?;
    let segs = audio_segments(&dir);
    if segs.is_empty() {
        return Err("録音データがありません".into());
    }
    for s in &segs {
        audio::repair_wav(s)?;
    }
    let out = dir.join("commentary.wav");
    let mut c = ff::cmd();
    c.arg("-y");
    for s in &segs {
        c.arg("-i").arg(s);
    }
    let ins: String = (0..segs.len()).map(|i| format!("[{i}:a]")).collect();
    c.args(["-filter_complex", &format!("{ins}concat=n={}:v=0:a=1,aresample=48000[a]", segs.len()), "-map", "[a]", "-ac", "1", "-c:a", "pcm_s16le"]);
    let st = c.arg(&out).stdout(Stdio::null()).stderr(Stdio::null()).status().map_err(|e| e.to_string())?;
    if !st.success() {
        return Err("録音データを確定できませんでした".into());
    }
    let secs = hound::WavReader::open(&out).map(|r| r.duration() as f64 / 48000.0).map_err(|e| e.to_string())?;
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    Ok((out.to_string_lossy().into(), secs))
}

/// Deletes all session data except `keep`; `cache` also removes the working-copy video.
#[tauri::command]
fn session_discard(app: AppHandle, keep: Option<String>, cache: bool) {
    for e in std::fs::read_dir(sessions_dir(&app)).into_iter().flatten().flatten() {
        if keep.as_deref() != Some(&*e.path().to_string_lossy()) {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
    if cache {
        let _ = std::fs::remove_dir_all(data_dir(&app).join("cache"));
    }
}

#[tauri::command]
fn export_work_dir(app: AppHandle) -> R<String> {
    let d = data_dir(&app).join("export_work");
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().into())
}

/// Writes one pre-rendered overlay PNG into export_work (name: [A-Za-z0-9_.] only).
#[tauri::command]
fn write_overlay(app: AppHandle, request: tauri::ipc::Request) -> R<String> {
    let name = request.headers().get("name").and_then(|v| v.to_str().ok()).ok_or("name")?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') || name.starts_with('.') {
        return Err("不正なファイル名です".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("raw body expected".into()) };
    let p = data_dir(&app).join("export_work").join(name);
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().into())
}

#[tauri::command]
fn export_start(app: AppHandle, state: State<AppState>, req: export::Req) -> R<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    *state.export_cancel.lock().unwrap() = Some(cancel.clone());
    let work = data_dir(&app).join("export_work");
    std::thread::spawn(move || {
        let a = app.clone();
        let r = export::run(req, &work, cancel, move |p| {
            let _ = a.emit("export-progress", p);
        });
        let _ = app.emit("export-done", r.map(|p| p.to_string_lossy().to_string()));
    });
    Ok(())
}

#[tauri::command]
fn export_cancel(state: State<AppState>) {
    if let Some(c) = state.export_cancel.lock().unwrap().as_ref() {
        c.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn partial_line_is_dropped_before_append() {
        let p = std::env::temp_dir().join("satoimo_partial_test.jsonl");
        std::fs::write(&p, "{\"k\":\"a\"}\n{\"k\":\"b\",\"t\"").unwrap();
        super::drop_partial_line(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"k\":\"a\"}\n");
        std::fs::write(&p, "{\"k\":\"b\"").unwrap();
        super::drop_partial_line(&p).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "");
        super::drop_partial_line(&p).unwrap(); // empty file is fine
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|_app| {
            // warm up encoder detection off the UI path
            std::thread::spawn(|| {
                ff::h264_encoder();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_video,
            make_proxy,
            mic_list,
            mic_open,
            mic_level,
            mic_close,
            session_create,
            rec_start,
            rec_stop,
            session_append,
            session_rewrite,
            session_find,
            session_audio_len,
            session_finalize,
            session_discard,
            export_work_dir,
            write_overlay,
            export_start,
            export_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
