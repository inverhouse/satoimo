use crate::{
    events,
    model::{ExportProgress, OutputSegment, Project, SessionEvent},
    project::{self, Result},
    timeline,
};
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, Command, Stdio},
    sync::Arc,
    thread::{self, JoinHandle},
    time::Instant,
};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Default)]
pub struct ExportState(pub Arc<Mutex<Option<Child>>>);

pub fn run(
    project_path: &Path,
    output_path: &Path,
    app: &AppHandle,
    state: &ExportState,
) -> Result<()> {
    let project = project::load(project_path)?;
    let take = project
        .take
        .as_ref()
        .ok_or("書き出せる収録がありません。")?;
    let event_path = project_path.join(&take.events_path);
    let audio_path = project_path.join(&take.audio_path);
    let events = events::read_valid(&event_path, false)?;
    let segments = timeline::build(&events)?;
    if segments.is_empty() {
        return Err("EXPORT_FAILED: 完成時間軸が空です。".into());
    }
    let cache = project_path.join("cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    write_ass(&cache.join("annotations.ass"), &events, take.duration_us)?;
    write_filter(&cache.join("render-filter.txt"), &project, &segments)?;
    let part = part_path(output_path);
    if part.exists() {
        fs::remove_file(&part).map_err(|e| e.to_string())?;
    }
    let selected_encoder = select_encoder()?;
    let mut command = Command::new(project::binary("ffmpeg"));
    command
        .current_dir(project_path)
        .arg("-hide_banner")
        .args(["-loglevel", "error"])
        .arg("-nostdin")
        .args(["-progress", "pipe:1", "-nostats", "-y", "-i"])
        .arg(&project.source.absolute_path)
        .arg("-i")
        .arg(&audio_path)
        .args([
            "-filter_complex_script",
            "cache/render-filter.txt",
            "-map",
            "[outv]",
            "-map",
            "[outa]",
            "-c:v",
        ])
        .arg(&selected_encoder)
        .args([
            "-b:v",
            "8M",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
        ])
        .arg(&part)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("FFMPEG_MISSING: FFmpegを起動できません: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("FFmpeg progressを取得できません。")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("FFmpegの診断出力を取得できません。")?;
    // Always drain stderr concurrently. Otherwise FFmpeg can fill the OS pipe
    // and block just before it closes the output file.
    let diagnostics = drain_stderr(stderr);
    *state.0.lock() = Some(child);
    let started = Instant::now();
    let reader = BufReader::new(stdout);
    let mut percent = 0.0;
    for line in reader.lines().map_while(|l| l.ok()) {
        if let Some(value) = line
            .strip_prefix("out_time_us=")
            .and_then(|v| v.parse::<u64>().ok())
        {
            let next = (value as f64 / take.duration_us.max(1) as f64 * 100.0).clamp(percent, 99.0);
            percent = next;
            let elapsed = started.elapsed().as_micros() as u64;
            let remaining = if next > 0.5 {
                Some((elapsed as f64 * (100.0 - next) / next) as u64)
            } else {
                None
            };
            let _ = app.emit(
                "export-progress",
                ExportProgress {
                    percent: next,
                    elapsed_us: elapsed,
                    remaining_us: remaining,
                    output_path: output_path.to_string_lossy().into_owned(),
                },
            );
        }
    }
    let mut child = state
        .0
        .lock()
        .take()
        .ok_or("書き出しがキャンセルされました。")?;
    let status = child.wait().map_err(|e| e.to_string())?;
    let diagnostics = diagnostics.join().unwrap_or_default();
    if !status.success() {
        let _ = fs::remove_file(&part);
        return Err(ffmpeg_failure("書き出し", status.to_string(), &diagnostics));
    }
    fs::rename(&part, output_path).map_err(|e| format!("出力ファイルを確定できません: {e}"))?;
    let _ = app.emit(
        "export-progress",
        ExportProgress {
            percent: 100.0,
            elapsed_us: started.elapsed().as_micros() as u64,
            remaining_us: Some(0),
            output_path: output_path.to_string_lossy().into_owned(),
        },
    );
    Ok(())
}

pub fn cancel(state: &ExportState) -> Result<()> {
    if let Some(child) = state.0.lock().as_mut() {
        child
            .kill()
            .map_err(|e| format!("書き出しを停止できません: {e}"))?;
    }
    Ok(())
}

pub fn run_proxy(project_path: &Path, app: &AppHandle, state: &ExportState) -> Result<Project> {
    let mut project = project::load(project_path)?;
    let proxy_dir = project_path.join("proxy");
    fs::create_dir_all(&proxy_dir).map_err(|e| e.to_string())?;
    let part = proxy_dir.join("source-proxy.mp4.part");
    let final_path = proxy_dir.join("source-proxy.mp4");
    let _ = fs::remove_file(&part);
    let mut command = Command::new(project::binary("ffmpeg"));
    command.args(["-hide_banner","-loglevel","error","-nostdin","-progress","pipe:1","-nostats","-y","-i"]).arg(&project.source.absolute_path).args(["-vf","scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=60","-c:v","libx264","-pix_fmt","yuv420p","-preset","fast"]);
    if project.source.has_audio {
        command.args(["-c:a", "aac", "-ar", "48000"]);
    } else {
        command.arg("-an");
    }
    command
        .args(["-f", "mp4"])
        .arg(&part)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("FFMPEG_MISSING: FFmpegを起動できません: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("FFmpeg progressを取得できません。")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("FFmpegの診断出力を取得できません。")?;
    let diagnostics = drain_stderr(stderr);
    *state.0.lock() = Some(child);
    let started = Instant::now();
    let mut percent = 0.0;
    for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
        if let Some(value) = line
            .strip_prefix("out_time_us=")
            .and_then(|v| v.parse::<u64>().ok())
        {
            percent = (value as f64 / project.source.duration_us.max(1) as f64 * 100.0)
                .clamp(percent, 99.0);
            let elapsed = started.elapsed().as_micros() as u64;
            let remaining = if percent > 0.5 {
                Some((elapsed as f64 * (100.0 - percent) / percent) as u64)
            } else {
                None
            };
            let _ = app.emit(
                "proxy-progress",
                ExportProgress {
                    percent,
                    elapsed_us: elapsed,
                    remaining_us: remaining,
                    output_path: final_path.to_string_lossy().into_owned(),
                },
            );
        }
    }
    let mut child = state
        .0
        .lock()
        .take()
        .ok_or("プロキシ作成がキャンセルされました。")?;
    let status = child.wait().map_err(|e| e.to_string())?;
    let diagnostics = diagnostics.join().unwrap_or_default();
    if !status.success() {
        let _ = fs::remove_file(&part);
        return Err(ffmpeg_failure(
            "プロキシ作成",
            status.to_string(),
            &diagnostics,
        ));
    }
    fs::rename(&part, &final_path).map_err(|e| e.to_string())?;
    project.proxy.status = "ready".into();
    project.proxy.relative_path = Some("proxy/source-proxy.mp4".into());
    project::save(&project)?;
    Ok(project)
}

const DIAGNOSTIC_LINE_LIMIT: usize = 32;

fn drain_stderr(stderr: ChildStderr) -> JoinHandle<String> {
    thread::spawn(move || {
        let mut tail = VecDeque::with_capacity(DIAGNOSTIC_LINE_LIMIT);
        for line in BufReader::new(stderr).lines().map_while(|line| line.ok()) {
            if tail.len() == DIAGNOSTIC_LINE_LIMIT {
                tail.pop_front();
            }
            tail.push_back(line);
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    })
}

fn ffmpeg_failure(operation: &str, status: String, diagnostics: &str) -> String {
    let detail = diagnostics.trim();
    if detail.is_empty() {
        format!(
            "EXPORT_FAILED: {operation}が終了コード{status}で停止しました。入力と収録データは保持されています。"
        )
    } else {
        format!(
            "EXPORT_FAILED: {operation}が終了コード{status}で停止しました。入力と収録データは保持されています。\n\nFFmpeg: {detail}"
        )
    }
}

fn part_path(output: &Path) -> PathBuf {
    let stem = output
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("output");
    output.with_file_name(format!("{stem}.part.mp4"))
}
fn select_encoder() -> Result<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        &["h264_videotoolbox", "libx264"]
    } else if cfg!(target_os = "windows") {
        &["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]
    } else {
        &["libx264"]
    };
    for encoder in candidates {
        let status = Command::new(project::binary("ffmpeg"))
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=size=320x180:rate=30",
                "-frames:v",
                "10",
                "-c:v",
                encoder,
                "-f",
                "null",
                "-",
            ])
            .status();
        if status.is_ok_and(|s| s.success()) {
            return Ok((*encoder).into());
        }
    }
    Err("FFMPEG_CAPABILITY: 利用可能なH.264 encoderがありません。FFmpegを再インストールしてください。".into())
}

fn write_filter(path: &Path, project: &Project, segments: &[OutputSegment]) -> Result<()> {
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    let mut concat = String::new();
    for (i, segment) in segments.iter().enumerate() {
        match segment {
            OutputSegment::Play {
                output_duration_us,
                source_start_us,
                source_end_us,
                rate,
                ..
            } => {
                writeln!(file,"[0:v]trim=start={:.6}:end={:.6},setpts=(PTS-STARTPTS)/{:.6},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1[v{i}];",*source_start_us as f64/1e6,*source_end_us as f64/1e6,rate).map_err(|e|e.to_string())?;
                if project.source.has_audio {
                    writeln!(
                        file,
                        "[0:a]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS,{}[a{i}];",
                        *source_start_us as f64 / 1e6,
                        *source_end_us as f64 / 1e6,
                        atempo(*rate)
                    )
                    .map_err(|e| e.to_string())?;
                } else {
                    writeln!(
                        file,
                        "anullsrc=r=48000:cl=stereo,atrim=duration={:.6}[a{i}];",
                        *output_duration_us as f64 / 1e6
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            OutputSegment::Freeze {
                output_duration_us,
                source_frame_us,
                ..
            } => {
                writeln!(file,"[0:v]trim=start={:.6}:end={:.6},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={:.6},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,trim=duration={:.6},setsar=1[v{i}];",*source_frame_us as f64/1e6,*source_frame_us as f64/1e6+0.05,*output_duration_us as f64/1e6,*output_duration_us as f64/1e6).map_err(|e|e.to_string())?;
                writeln!(
                    file,
                    "anullsrc=r=48000:cl=stereo,atrim=duration={:.6}[a{i}];",
                    *output_duration_us as f64 / 1e6
                )
                .map_err(|e| e.to_string())?;
            }
        }
        concat.push_str(&format!("[v{i}][a{i}]"));
    }
    writeln!(
        file,
        "{concat}concat=n={}:v=1:a=1[basev][sourcea];",
        segments.len()
    )
    .map_err(|e| e.to_string())?;
    writeln!(file, "[basev]ass=filename='cache/annotations.ass'[outv];")
        .map_err(|e| e.to_string())?;
    writeln!(file,"[sourcea]volume={:.6}[sa];[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration={:.6},volume={:.6}[ma];[sa][ma]amix=inputs=2:duration=longest:normalize=0,atrim=duration={:.6}[outa]",project.mix.source_gain,segments.iter().map(OutputSegment::duration_us).sum::<u64>() as f64/1e6,project.mix.microphone_gain,segments.iter().map(OutputSegment::duration_us).sum::<u64>() as f64/1e6).map_err(|e|e.to_string())?;
    Ok(())
}
fn atempo(rate: f64) -> String {
    if (rate - 0.25).abs() < f64::EPSILON {
        "atempo=0.5,atempo=0.5".into()
    } else {
        format!("atempo={rate:.6}")
    }
}

fn write_ass(path: &Path, events: &[SessionEvent], duration_us: u64) -> Result<()> {
    let mut file = File::create(path).map_err(|e| e.to_string())?;
    writeln!(file,"[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Draw,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text").map_err(|e|e.to_string())?;
    let mut active =
        std::collections::HashMap::<String, (String, f64, Vec<(u64, f64, f64)>)>::new();
    let mut hides = std::collections::HashMap::<String, u64>::new();
    for e in events {
        match e.event_type.as_str() {
            "stroke_begin" => {
                let id = e.payload["strokeId"].as_str().unwrap_or("").to_string();
                active.insert(
                    id,
                    (
                        e.payload["color"].as_str().unwrap_or("#FF3B30").into(),
                        e.payload["widthNormalized"].as_f64().unwrap_or(0.0074),
                        vec![(
                            e.session_us,
                            e.payload["x"].as_f64().unwrap_or(0.0),
                            e.payload["y"].as_f64().unwrap_or(0.0),
                        )],
                    ),
                );
            }
            "stroke_point" | "stroke_end" => {
                if let Some(s) = active.get_mut(e.payload["strokeId"].as_str().unwrap_or("")) {
                    s.2.push((
                        e.session_us,
                        e.payload["x"].as_f64().unwrap_or(0.0),
                        e.payload["y"].as_f64().unwrap_or(0.0),
                    ));
                }
            }
            "stroke_hide" => {
                if let Some(ids) = e.payload["strokeIds"].as_array() {
                    for id in ids {
                        if let Some(id) = id.as_str() {
                            hides.entry(id.into()).or_insert(e.session_us);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    for (id, (color, width, points)) in active {
        let end = hides.get(&id).copied().unwrap_or(duration_us);
        for index in 1..points.len() {
            let (at, _, _) = points[index];
            let mut path_data = String::new();
            for (_, x, y) in &points[..=index] {
                if path_data.is_empty() {
                    path_data = format!("m {} {}", (x * 1920.0) as i32, (y * 1080.0) as i32);
                } else {
                    path_data.push_str(&format!(
                        " l {} {}",
                        (x * 1920.0) as i32,
                        (y * 1080.0) as i32
                    ));
                }
            }
            let ass_color = format!("&H00{}{}{}&", &color[5..7], &color[3..5], &color[1..3]);
            writeln!(file,"Dialogue: 0,{},{},Draw,,0,0,0,,{{\\p1\\c{}\\bord0\\shad0\\1a&H00&\\be1\\fnArial\\fs{}}}{}",ass_time(at),ass_time(end),ass_color,(width*1080.0).round(),path_data).map_err(|e|e.to_string())?;
        }
    }
    Ok(())
}
fn ass_time(us: u64) -> String {
    let cs = us / 10_000;
    format!(
        "{}:{:02}:{:02}.{:02}",
        cs / 360000,
        (cs / 6000) % 60,
        (cs / 100) % 60,
        cs % 100
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quarter_speed_chains_atempo() {
        assert_eq!(atempo(0.25), "atempo=0.5,atempo=0.5");
    }
    #[test]
    fn part_does_not_replace_final() {
        assert_eq!(
            part_path(Path::new("/a/out.mp4")),
            PathBuf::from("/a/out.part.mp4")
        );
    }
}
