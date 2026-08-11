use crate::{model::SessionEvent, project::Result};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

pub struct EventWriter {
    path: PathBuf,
    writer: BufWriter<File>,
    clock: Instant,
    last_sync: Instant,
    seq: u64,
    last_us: u64,
    playing: bool,
}

impl EventWriter {
    pub fn start(
        project_path: &Path,
        source_us: u64,
        rate: f64,
        mix: Value,
        audio_format: Value,
    ) -> Result<Self> {
        let path = project_path.join("events/take-current.jsonl.part");
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .map_err(|e| format!("イベントログを作成できません: {e}"))?;
        let now = Instant::now();
        let mut writer = Self {
            path,
            writer: BufWriter::new(file),
            clock: now,
            last_sync: now,
            seq: 0,
            last_us: 0,
            playing: false,
        };
        writer.append_at(
            0,
            "session_start",
            json!({"sourceUs":source_us,"rate":rate,"mix":mix,"audioFormat":audio_format}),
        )?;
        writer.sync()?;
        Ok(writer)
    }
    pub fn append(
        &mut self,
        event_type: &str,
        payload: Value,
        source_duration_us: u64,
    ) -> Result<SessionEvent> {
        validate(event_type, &payload, source_duration_us, self.playing)?;
        match event_type {
            "play" => self.playing = true,
            "pause" => self.playing = false,
            "seek" => {
                self.playing = payload
                    .get("continuesPlaying")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            }
            "rate_change" => {
                self.playing = payload
                    .get("playing")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            }
            "session_stop" | "interruption" => self.playing = false,
            _ => {}
        }
        let now = self.clock.elapsed().as_micros() as u64;
        self.append_at(now.max(self.last_us), event_type, payload)
    }
    fn append_at(
        &mut self,
        session_us: u64,
        event_type: &str,
        payload: Value,
    ) -> Result<SessionEvent> {
        self.seq += 1;
        self.last_us = session_us;
        let event = SessionEvent {
            schema_version: 1,
            seq: self.seq,
            session_us,
            event_type: event_type.into(),
            payload,
        };
        serde_json::to_writer(&mut self.writer, &event).map_err(|e| e.to_string())?;
        self.writer.write_all(b"\n").map_err(|e| e.to_string())?;
        if important(event_type) {
            self.writer.flush().map_err(|e| e.to_string())?;
        }
        if self.last_sync.elapsed().as_secs() >= 5 {
            self.sync()?;
        }
        Ok(event)
    }
    pub fn stop(mut self, source_us: u64, playing: bool) -> Result<(u64, PathBuf)> {
        let event = self.append(
            "session_stop",
            json!({"sourceUs":source_us,"playing":playing}),
            source_us.max(1),
        )?;
        self.sync()?;
        drop(self.writer);
        let final_path = self.path.with_file_name("take-current.jsonl");
        fs::rename(&self.path, &final_path)
            .map_err(|e| format!("イベントログを確定できません: {e}"))?;
        Ok((event.session_us, final_path))
    }
    pub fn interrupt(mut self, source_us: u64, reason: &str) -> Result<(u64, PathBuf)> {
        let event = self.append("interruption", json!({"reason":reason}), source_us.max(1))?;
        self.sync()?;
        drop(self.writer);
        let final_path = self.path.with_file_name("take-current.jsonl");
        fs::rename(&self.path, &final_path)
            .map_err(|e| format!("イベントログを確定できません: {e}"))?;
        Ok((event.session_us, final_path))
    }
    fn sync(&mut self) -> Result<()> {
        self.writer.flush().map_err(|e| e.to_string())?;
        self.writer
            .get_ref()
            .sync_all()
            .map_err(|e| e.to_string())?;
        self.last_sync = Instant::now();
        Ok(())
    }
}

fn important(kind: &str) -> bool {
    matches!(
        kind,
        "session_start"
            | "play"
            | "pause"
            | "seek"
            | "rate_change"
            | "stroke_hide"
            | "session_stop"
            | "interruption"
    )
}
fn validate(kind: &str, payload: &Value, duration: u64, playing: bool) -> Result<()> {
    const TYPES: &[&str] = &[
        "play",
        "pause",
        "seek",
        "rate_change",
        "stroke_begin",
        "stroke_point",
        "stroke_end",
        "stroke_hide",
        "session_stop",
        "interruption",
    ];
    if !TYPES.contains(&kind) {
        return Err("未知のイベント種別です。".into());
    }
    if kind == "play" && playing {
        return Err("再生中にplayイベントは記録できません。".into());
    }
    if kind == "pause" && !playing {
        return Err("停止中にpauseイベントは記録できません。".into());
    }
    if kind.starts_with("stroke_") && playing {
        return Err("再生中は描画できません。".into());
    }
    for key in ["sourceUs", "fromSourceUs", "toSourceUs"] {
        if let Some(value) = payload.get(key).and_then(|v| v.as_u64()) {
            if value > duration {
                return Err(format!("{key}が動画範囲外です。"));
            }
        }
    }
    for key in ["x", "y", "pressure"] {
        if let Some(value) = payload.get(key).and_then(|v| v.as_f64()) {
            if !(0.0..=1.0).contains(&value) {
                return Err(format!("{key}は0〜1で指定してください。"));
            }
        }
    }
    for key in ["rate", "fromRate", "toRate"] {
        if let Some(value) = payload.get(key).and_then(|v| v.as_f64()) {
            if ![0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0].contains(&value) {
                return Err(format!("{key}が許可されていません。"));
            }
        }
    }
    Ok(())
}

pub fn read_valid(path: &Path, allow_truncated_tail: bool) -> Result<Vec<SessionEvent>> {
    let file = File::open(path).map_err(|e| format!("イベントログを開けません: {e}"))?;
    let mut events = Vec::new();
    let lines: Vec<_> = BufReader::new(file).lines().collect();
    for (index, line) in lines.iter().enumerate() {
        match line {
            Ok(text) if !text.trim().is_empty() => match serde_json::from_str::<SessionEvent>(text)
            {
                Ok(event) => {
                    if event.seq != events.len() as u64 + 1
                        || events
                            .last()
                            .is_some_and(|e: &SessionEvent| e.session_us > event.session_us)
                    {
                        return Err(format!("イベント{}の順序が不正です。", index + 1));
                    }
                    events.push(event);
                }
                Err(_) if allow_truncated_tail && index == lines.len() - 1 => break,
                Err(e) => {
                    return Err(format!(
                        "イベントログの途中行{}が破損しています: {e}",
                        index + 1
                    ))
                }
            },
            Ok(_) => {}
            Err(e) if allow_truncated_tail && index == lines.len() - 1 => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(events)
}

pub type SharedWriter = Arc<Mutex<Option<EventWriter>>>;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn truncated_tail_is_removed_only_at_end() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("e");
        fs::write(&p,b"{\"schemaVersion\":1,\"seq\":1,\"sessionUs\":0,\"type\":\"session_start\",\"payload\":{}}\n{bad").unwrap();
        assert_eq!(read_valid(&p, true).unwrap().len(), 1);
    }
}
