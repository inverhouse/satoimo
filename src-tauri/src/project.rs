use crate::model::*;
use chrono::Utc;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
};
use sysinfo::{Pid, ProcessesToUpdate, System};

pub type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
struct Probe {
    streams: Vec<ProbeStream>,
    format: ProbeFormat,
}
#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}
#[derive(Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    tags: Option<serde_json::Value>,
    side_data_list: Option<Vec<serde_json::Value>>,
}

pub fn binary(name: &str) -> PathBuf {
    if let Ok(custom) = std::env::var(format!("SATOIMO_{}_PATH", name.to_uppercase())) {
        return PathBuf::from(custom);
    }
    if let Ok(exe) = std::env::current_exe() {
        let sibling = exe.parent().unwrap_or(Path::new(".")).join(name);
        if sibling.exists() {
            return sibling;
        }
    }
    PathBuf::from(name)
}

pub fn analyze_source(path: &Path) -> Result<SourceInfo> {
    let canonical = path.canonicalize().map_err(|_| {
        "SOURCE_MISSING: 元動画が見つかりません。再リンクしてください。".to_string()
    })?;
    let output = Command::new(binary("ffprobe"))
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(&canonical)
        .output()
        .map_err(|e| format!("FFMPEG_MISSING: ffprobeを起動できません: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "MEDIA_UNSUPPORTED: 動画を解析できません: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let probe: Probe = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("MEDIA_UNSUPPORTED: ffprobe結果が不正です: {e}"))?;
    let video = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("video"))
        .ok_or_else(|| "MEDIA_UNSUPPORTED: 映像ストリームがありません。".to_string())?;
    let audio = probe
        .streams
        .iter()
        .find(|s| s.codec_type.as_deref() == Some("audio"));
    let (fps_numerator, fps_denominator) = parse_ratio(
        video
            .avg_frame_rate
            .as_deref()
            .or(video.r_frame_rate.as_deref())
            .unwrap_or("30/1"),
    );
    let rotation_degrees = rotation(video);
    Ok(SourceInfo {
        absolute_path: canonical.to_string_lossy().into_owned(),
        relative_path: None,
        fingerprint: fingerprint(&canonical)?,
        duration_us: (probe
            .format
            .duration
            .as_deref()
            .unwrap_or("0")
            .parse::<f64>()
            .unwrap_or(0.0)
            * 1_000_000.0)
            .round() as u64,
        width: video.width.unwrap_or(0),
        height: video.height.unwrap_or(0),
        fps_numerator,
        fps_denominator,
        video_codec: video.codec_name.clone().unwrap_or_default(),
        audio_codec: audio.and_then(|a| a.codec_name.clone()),
        has_audio: audio.is_some(),
        rotation_degrees,
    })
}

fn rotation(stream: &ProbeStream) -> i32 {
    if let Some(value) = stream
        .tags
        .as_ref()
        .and_then(|v| v.get("rotate"))
        .and_then(|v| v.as_str())
        .and_then(|v| v.parse().ok())
    {
        return value;
    }
    stream
        .side_data_list
        .as_ref()
        .and_then(|list| {
            list.iter()
                .find_map(|v| v.get("rotation").and_then(|r| r.as_i64()))
        })
        .unwrap_or(0) as i32
}

fn parse_ratio(value: &str) -> (u32, u32) {
    let mut parts = value.split('/');
    let numerator = parts.next().and_then(|v| v.parse().ok()).unwrap_or(30);
    let denominator = parts
        .next()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(1);
    (numerator, denominator)
}

pub fn fingerprint(path: &Path) -> Result<Fingerprint> {
    let metadata = path.metadata().map_err(|e| e.to_string())?;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let chunk = 1024 * 1024;
    let mut buffer = vec![0; chunk];
    let head = file.read(&mut buffer).map_err(|e| e.to_string())?;
    hasher.update(&buffer[..head]);
    if metadata.len() > chunk as u64 {
        file.seek(SeekFrom::End(-(chunk as i64)))
            .map_err(|e| e.to_string())?;
        let tail = file.read(&mut buffer).map_err(|e| e.to_string())?;
        hasher.update(&buffer[..tail]);
    }
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(Fingerprint {
        size_bytes: metadata.len(),
        modified_at_ms,
        head_tail_sha256: hex::encode(hasher.finalize()),
    })
}

pub fn create(source_path: &Path, parent: &Path, name: &str) -> Result<Project> {
    diagnose_ffmpeg()?;
    if name.trim().is_empty() {
        return Err("プロジェクト名を入力してください。".into());
    }
    let safe = sanitize_name(name);
    let project_path = parent.join(format!("{safe}.satoimo"));
    if project_path.exists() {
        return Err("同名のプロジェクトが既にあります。別の名前を指定してください。".into());
    }
    for child in ["events", "audio", "proxy", "cache", "recovery", "exports"] {
        fs::create_dir_all(project_path.join(child))
            .map_err(|e| format!("プロジェクトフォルダを作成できません: {e}"))?;
    }
    acquire_lock(&project_path)?;
    let now = Utc::now().to_rfc3339();
    let source = analyze_source(source_path)?;
    let needs_proxy = source.video_codec != "h264"
        || source.width.max(source.height) > 1920
        || source.fps_numerator as f64 / source.fps_denominator as f64 > 65.0
        || probe_vfr(source_path);
    let project = Project {
        schema_version: 1,
        app_version: env!("CARGO_PKG_VERSION").into(),
        project_id: uuid::Uuid::new_v4().to_string(),
        name: name.trim().into(),
        project_path: project_path.to_string_lossy().into_owned(),
        created_at: now.clone(),
        updated_at: now,
        source,
        media_url: String::new(),
        audio_url: String::new(),
        proxy: ProxyInfo {
            status: if needs_proxy { "needed" } else { "none" }.into(),
            relative_path: None,
        },
        mix: default_mix(),
        pen: Pen {
            color: "#FF3B30".into(),
            width_normalized: 8.0 / 1080.0,
        },
        take: None,
        last_source_position_us: 0,
        ui: UiState {
            right_panel_collapsed: false,
        },
    };
    save(&project)?;
    remember(&project)?;
    Ok(project)
}

fn default_mix() -> Mix {
    Mix {
        microphone_gain: 1.0,
        source_gain: 0.20,
    }
}

fn probe_vfr(path: &Path) -> bool {
    let output = Command::new(binary("ffprobe"))
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=avg_frame_rate,r_frame_rate",
            "-of",
            "json",
        ])
        .arg(path)
        .output();
    let Ok(output) = output else { return false };
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    let Some(stream) = value
        .get("streams")
        .and_then(|v| v.as_array())
        .and_then(|v| v.first())
    else {
        return false;
    };
    let avg = stream
        .get("avg_frame_rate")
        .and_then(|v| v.as_str())
        .map(parse_ratio);
    let real = stream
        .get("r_frame_rate")
        .and_then(|v| v.as_str())
        .map(parse_ratio);
    match (avg, real) {
        (Some((an, ad)), Some((rn, rd))) => {
            (an as u64 * rd as u64).abs_diff(rn as u64 * ad as u64) > 1
        }
        _ => false,
    }
}

pub fn diagnose_ffmpeg() -> Result<()> {
    let output = Command::new(binary("ffmpeg"))
        .args(["-hide_banner", "-filters"])
        .output()
        .map_err(|e| format!("FFMPEG_MISSING: FFmpegを起動できません: {e}"))?;
    if !output.status.success() {
        return Err(
            "FFMPEG_MISSING: FFmpegの診断に失敗しました。再インストールしてください。".into(),
        );
    }
    let filters = String::from_utf8_lossy(&output.stdout);
    if !filters
        .lines()
        .any(|line| line.split_whitespace().any(|part| part == "ass"))
    {
        return Err("FFMPEG_CAPABILITY: libassのass filterがありません。対応FFmpegを再インストールしてください。".into());
    }
    Ok(())
}

fn sanitize_name(name: &str) -> String {
    let result: String = name
        .trim()
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '＿'
            } else {
                c
            }
        })
        .collect();
    result.chars().take(80).collect()
}

pub fn load(path: &Path) -> Result<Project> {
    let project_file = if path.is_dir() {
        path.join("project.json")
    } else {
        path.to_path_buf()
    };
    let root = project_file
        .parent()
        .ok_or("PROJECT_CORRUPT: プロジェクトパスが不正です。")?;
    acquire_lock(root)?;
    let bytes = fs::read(&project_file)
        .or_else(|_| fs::read(root.join("project.json.bak")))
        .map_err(|e| format!("PROJECT_CORRUPT: project.jsonとbackupを読み込めません: {e}"))?;
    let mut project: Project = serde_json::from_slice(&bytes)
        .map_err(|e| format!("PROJECT_CORRUPT: JSONが破損しています: {e}"))?;
    project.project_path = root.to_string_lossy().into_owned();
    project.media_url.clear();
    project.audio_url.clear();
    let current = fingerprint(Path::new(&project.source.absolute_path)).map_err(|_| {
        "SOURCE_MISSING: 元動画が見つかりません。再リンクしてください。".to_string()
    })?;
    if current != project.source.fingerprint {
        return Err(
            "SOURCE_MISMATCH: 元動画の内容が変更されています。再リンクして確認してください。"
                .into(),
        );
    }
    remember(&project)?;
    Ok(project)
}

pub fn save(project: &Project) -> Result<()> {
    let root = Path::new(&project.project_path);
    let target = root.join("project.json");
    let temp = root.join("project.json.tmp");
    let backup = root.join("project.json.bak");
    let mut stored = project.clone();
    stored.media_url.clear();
    stored.audio_url.clear();
    stored.updated_at = Utc::now().to_rfc3339();
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    let mut file = File::create(&temp).map_err(|e| format!("project.jsonを保存できません: {e}"))?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    if target.exists() {
        let _ = fs::copy(&target, &backup);
    }
    fs::rename(&temp, &target).map_err(|e| format!("project.jsonを確定できません: {e}"))?;
    Ok(())
}

fn acquire_lock(root: &Path) -> Result<()> {
    let path = root.join("project.lock");
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(pid) = text.trim().parse::<u32>() {
            if pid != std::process::id() {
                let mut system = System::new();
                system.refresh_processes(ProcessesToUpdate::All, true);
                if system.process(Pid::from_u32(pid)).is_some() {
                    return Err("このプロジェクトは別の「さといも」で開かれています。".into());
                }
            }
        }
    }
    fs::write(path, std::process::id().to_string())
        .map_err(|e| format!("project.lockを作成できません: {e}"))
}

fn recent_path() -> Result<PathBuf> {
    dirs::config_local_dir()
        .map(|p| p.join("satoimo").join("recent.json"))
        .ok_or_else(|| "設定フォルダを取得できません。".into())
}
pub fn recent() -> Result<Vec<Project>> {
    let path = recent_path()?;
    let paths: Vec<String> = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    Ok(paths
        .into_iter()
        .filter_map(|p| {
            let bytes = fs::read(Path::new(&p).join("project.json")).ok()?;
            let mut project: Project = serde_json::from_slice(&bytes).ok()?;
            project.project_path = p;
            Some(project)
        })
        .take(8)
        .collect())
}
fn remember(project: &Project) -> Result<()> {
    let path = recent_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut paths: Vec<String> = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    paths.retain(|p| p != &project.project_path);
    paths.insert(0, project.project_path.clone());
    paths.truncate(8);
    fs::write(path, serde_json::to_vec_pretty(&paths).unwrap()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ratios_are_safe() {
        assert_eq!(parse_ratio("60000/1001"), (60000, 1001));
        assert_eq!(parse_ratio("oops"), (30, 1));
    }
    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize_name("a/b:c"), "a＿b＿c");
    }
    #[test]
    fn source_audio_defaults_to_twenty_percent() {
        let mix = default_mix();
        assert_eq!(mix.microphone_gain, 1.0);
        assert_eq!(mix.source_gain, 0.20);
    }
    #[test]
    fn fingerprint_compares_head_and_tail() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a");
        fs::write(&p, b"abcdef").unwrap();
        assert_eq!(fingerprint(&p).unwrap(), fingerprint(&p).unwrap());
    }
}
