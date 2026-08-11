use crate::{
    events,
    model::{Project, RecoveryCandidate, TakeInfo},
    project::{self, Result},
};
use chrono::Utc;
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
};

pub fn candidates() -> Result<Vec<RecoveryCandidate>> {
    let mut result = Vec::new();
    for recent in project::recent()? {
        let root = Path::new(&recent.project_path);
        let event_path = root.join("events/take-current.jsonl.part");
        let audio_path = root.join("audio/take-current.wav.part");
        if event_path.exists() || audio_path.exists() {
            let count = if event_path.exists() {
                events::read_valid(&event_path, true)
                    .map(|v| v.len())
                    .unwrap_or(0)
            } else {
                0
            };
            result.push(RecoveryCandidate {
                project_path: recent.project_path,
                project_name: recent.name,
                audio_bytes: audio_path.metadata().map(|m| m.len()).unwrap_or(0),
                valid_event_count: count,
            });
        }
    }
    Ok(result)
}

pub fn recover(path: &Path) -> Result<Project> {
    let mut project = project::load(path)?;
    let events_part = path.join("events/take-current.jsonl.part");
    let audio_part = path.join("audio/take-current.wav.part");
    let mut list = events::read_valid(&events_part, true)?;
    if list.is_empty() {
        return Err("復旧可能なイベントがありません。".into());
    }
    let audio_us = repair_wav(&audio_part)?;
    let last_event_us = list.last().map(|e| e.session_us).unwrap_or(0);
    let duration_us = last_event_us.min(audio_us);
    if !matches!(
        list.last().map(|e| e.event_type.as_str()),
        Some("session_stop" | "interruption")
    ) {
        let event = crate::model::SessionEvent {
            schema_version: 1,
            seq: list.len() as u64 + 1,
            session_us: duration_us,
            event_type: "interruption".into(),
            payload: json!({"reason":"crash_recovery"}),
        };
        let mut file = OpenOptions::new()
            .append(true)
            .open(&events_part)
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut file, &event).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        list.push(event);
    }
    let events_final = path.join("events/take-current.jsonl");
    let audio_final = path.join("audio/take-current.wav");
    fs::rename(events_part, &events_final).map_err(|e| e.to_string())?;
    fs::rename(audio_part, &audio_final).map_err(|e| e.to_string())?;
    project.take = Some(TakeInfo {
        id: uuid::Uuid::new_v4().to_string(),
        duration_us,
        events_path: "events/take-current.jsonl".into(),
        audio_path: "audio/take-current.wav".into(),
        recovered: true,
    });
    project::save(&project)?;
    Ok(project)
}

fn repair_wav(path: &Path) -> Result<u64> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("WAVを開けません: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len < 44 {
        return Err("WAVデータが短すぎて復旧できません。".into());
    }
    let data = (len - 44).min(u32::MAX as u64) as u32;
    file.seek(SeekFrom::Start(4)).map_err(|e| e.to_string())?;
    file.write_all(&(36u32.saturating_add(data)).to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(40)).map_err(|e| e.to_string())?;
    file.write_all(&data.to_le_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    let mut header = [0u8; 44];
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    std::io::Read::read_exact(&mut file, &mut header).map_err(|e| e.to_string())?;
    let sample_rate = u32::from_le_bytes(header[24..28].try_into().unwrap()).max(1);
    let channels = u16::from_le_bytes(header[22..24].try_into().unwrap()).max(1);
    let bits = u16::from_le_bytes(header[34..36].try_into().unwrap()).max(1);
    Ok(data as u64 * 8 * 1_000_000 / (sample_rate as u64 * channels as u64 * bits as u64))
}

pub fn discard(path: &Path) -> Result<Project> {
    let recovery = path
        .join("recovery")
        .join(Utc::now().format("%Y%m%d-%H%M%S").to_string());
    fs::create_dir_all(&recovery).map_err(|e| e.to_string())?;
    for relative in [
        "events/take-current.jsonl.part",
        "audio/take-current.wav.part",
    ] {
        let source = path.join(relative);
        if source.exists() {
            fs::rename(&source, recovery.join(source.file_name().unwrap()))
                .map_err(|e| e.to_string())?;
        }
    }
    project::load(path)
}

pub fn archive_take(path: &Path) -> Result<Project> {
    let mut project = project::load(path)?;
    let recovery = path
        .join("recovery")
        .join(format!("take-{}", Utc::now().format("%Y%m%d-%H%M%S")));
    fs::create_dir_all(&recovery).map_err(|e| e.to_string())?;
    for relative in ["events/take-current.jsonl", "audio/take-current.wav"] {
        let source = path.join(relative);
        if source.exists() {
            fs::copy(&source, recovery.join(source.file_name().unwrap()))
                .map_err(|e| e.to_string())?;
        }
    }
    project.take = None;
    project::save(&project)?;
    Ok(project)
}
