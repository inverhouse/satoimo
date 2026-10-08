// MP4 export: source frames are decoded by an ffmpeg child (raw RGBA, already letterboxed to
// 1920x1080), overlay PNGs pre-rendered by the frontend are alpha-blended here, and the result
// is piped into a second ffmpeg that encodes H.264/AAC. Memory stays at a few frame buffers.
use crate::ff;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

pub const W: usize = 1920;
pub const H: usize = 1080;
pub const FPS: f64 = 30.0;
const AR: f64 = 48000.0;
const SOURCE_UNREADABLE: &str = "元動画を読み込めませんでした。動画ファイルが移動・削除・変更されていないか確認してください";

#[derive(Deserialize, Clone)]
pub struct Seg {
    pub t: f64,
    pub pos: f64,
    pub playing: bool,
    pub rate: f64,
    pub board: bool,
}

#[derive(Deserialize)]
pub struct Overlay {
    pub frame: u64,
    pub file: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Req {
    pub source: String,
    pub src_fps: f64,
    pub src_duration: f64,
    pub has_audio: bool,
    #[serde(default)]
    pub color_tagged: bool,
    pub commentary: String,
    pub duration: f64,
    pub segs: Vec<Seg>,
    pub overlays: Vec<Overlay>,
    pub out_dir: String,
    pub file_name: String,
    pub voice_gain: f64,
    pub source_gain: f64,
}

#[derive(Serialize, Clone)]
pub struct Progress {
    pub phase: &'static str,
    pub ratio: f64,
}

/// `name.mp4`, then `name_2.mp4`, ... — never an existing file.
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let p = dir.join(file_name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = file_name.rsplit_once('.').unwrap_or((file_name, "mp4"));
    (2..).map(|n| dir.join(format!("{stem}_{n}.{ext}"))).find(|p| !p.exists()).unwrap()
}

fn seg_end(segs: &[Seg], i: usize, duration: f64) -> f64 {
    segs.get(i + 1).map_or(duration, |s| s.t).min(duration)
}

/// Builds the source-audio track (s16le stereo 48k) following the recorded timeline.
/// Pitch-preserving tempo change matches what the WebView does at non-1x speed.
fn build_source_audio(req: &Req, out: &Path, cancel: &AtomicBool, prog: &dyn Fn(f64)) -> Result<(), String> {
    let mut w = BufWriter::new(File::create(out).map_err(|e| e.to_string())?);
    let total = (req.duration * AR).round() as u64;
    let mut written: u64 = 0;
    let zeros = vec![0u8; 4 * 4800];
    let pad_to = |w: &mut BufWriter<File>, written: &mut u64, target: u64| -> Result<(), String> {
        while *written < target {
            let n = ((target - *written) as usize).min(4800);
            w.write_all(&zeros[..n * 4]).map_err(|e| e.to_string())?;
            *written += n as u64;
        }
        Ok(())
    };
    for (i, s) in req.segs.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let end = seg_end(&req.segs, i, req.duration);
        let (a, b) = ((s.t * AR).round() as u64, (end * AR).round() as u64);
        if !s.playing || s.board || b <= a || s.pos >= req.src_duration {
            continue;
        }
        pad_to(&mut w, &mut written, a)?;
        let src_len = (end - s.t) * s.rate;
        let mut cmd = ff::cmd();
        cmd.args(["-ss", &format!("{:.4}", s.pos), "-t", &format!("{:.4}", src_len + 0.05), "-i", &req.source, "-vn"]);
        if (s.rate - 1.0).abs() > 1e-6 {
            cmd.args(["-af", &format!("atempo={}", s.rate)]);
        }
        cmd.args(["-ar", "48000", "-ac", "2", "-f", "s16le", "-"]).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("FFmpegを起動できません: {e}"))?;
        let mut so = child.stdout.take().unwrap();
        let mut buf = vec![0u8; 4 * 4800];
        let mut got = 0u64;
        while written < b {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("cancelled".into());
            }
            let want = (((b - written) as usize).min(4800)) * 4;
            let n = read_full(&mut so, &mut buf[..want]).map_err(|e| e.to_string())?;
            let n = n / 4 * 4;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            written += (n / 4) as u64;
            got += n as u64;
        }
        let _ = child.kill();
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        // nothing decoded for a section inside the source and ffmpeg failed => the source is unreadable
        if got == 0 && !ok && s.pos < req.src_duration - 0.5 {
            return Err(SOURCE_UNREADABLE.into());
        }
        pad_to(&mut w, &mut written, b)?;
        prog(i as f64 / req.segs.len() as f64);
    }
    pad_to(&mut w, &mut written, total)?;
    w.flush().map_err(|e| e.to_string())
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// Sequential reader of letterboxed RGBA source frames; restarts ffmpeg on backward/far seeks.
struct Reader {
    src: String,
    duration: f64,
    pre: &'static str,
    fps: f64,
    child: Option<(Child, ChildStdout)>,
    buf: Vec<u8>,
    tmp: Vec<u8>,
    cur_t: f64,
    next_t: f64,
    has: bool,
    eof: bool,
}

impl Reader {
    fn new(src: &str, fps: f64, duration: f64, color_tagged: bool) -> Reader {
        Reader { src: src.into(), duration, pre: if color_tagged { "" } else { ff::ASSUME_709 }, fps, child: None, buf: vec![0; W * H * 4], tmp: vec![0; W * H * 4], cur_t: 0.0, next_t: 0.0, has: false, eof: true }
    }

    fn start(&mut self, p: f64) -> Result<(), String> {
        self.stop();
        let vf = format!(
            "{pre}fps={fps},scale=iw*sar:ih,scale={W}:{H}:force_original_aspect_ratio=decrease:flags=bicubic,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgba",
            pre = self.pre,
            fps = self.fps
        );
        let mut c = ff::cmd()
            .args(["-ss", &format!("{p:.4}"), "-i", &self.src, "-an", "-sn", "-vf", &vf, "-f", "rawvideo", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("FFmpegを起動できません: {e}"))?;
        let so = c.stdout.take().unwrap();
        self.child = Some((c, so));
        self.cur_t = p;
        self.next_t = p;
        self.eof = false;
        self.read_one()
    }

    fn read_one(&mut self) -> Result<(), String> {
        let Some((c, so)) = self.child.as_mut() else { return Ok(()) };
        let n = read_full(so, &mut self.tmp).map_err(|e| e.to_string())?;
        if n < self.tmp.len() {
            // A decoder that fails, or yields no frame for a position well inside the video, is an
            // error — not a normal end. Otherwise a moved/deleted source exports as black video.
            let ok = c.wait().map(|s| s.success()).unwrap_or(false);
            let first = self.next_t == self.cur_t;
            if !ok || (first && self.cur_t < self.duration - 1.0) {
                return Err(SOURCE_UNREADABLE.into());
            }
            self.eof = true; // past the last frame: keep showing it
            return Ok(());
        }
        std::mem::swap(&mut self.buf, &mut self.tmp);
        self.has = true;
        self.cur_t = self.next_t;
        self.next_t += 1.0 / self.fps;
        Ok(())
    }

    fn frame_at(&mut self, p: f64) -> Result<&[u8], String> {
        let half = 0.5 / self.fps;
        if self.child.is_none() || !self.has || p < self.cur_t - half || p > self.next_t + 2.0 {
            self.start(p)?;
        }
        while !self.eof && self.next_t <= p + half {
            self.read_one()?;
        }
        Ok(&self.buf)
    }

    fn stop(&mut self) {
        if let Some((mut c, _)) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Reader {
    fn drop(&mut self) {
        self.stop();
    }
}

fn load_png(path: &str) -> Result<(Vec<u8>, bool), String> {
    let dec = png::Decoder::new(std::io::BufReader::new(File::open(path).map_err(|e| e.to_string())?));
    let mut r = dec.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; r.output_buffer_size().ok_or("png")?];
    let info = r.next_frame(&mut buf).map_err(|e| e.to_string())?;
    if info.width as usize != W || info.height as usize != H || info.color_type != png::ColorType::Rgba {
        return Err("オーバーレイ画像の形式が不正です".into());
    }
    buf.truncate(W * H * 4);
    let opaque = buf.chunks_exact(4).all(|p| p[3] == 255);
    Ok((buf, opaque))
}

/// out = ov·a + src·(1−a), straight (non-premultiplied) alpha as written by canvas PNGs.
pub fn blend(src: &[u8], ov: &[u8], out: &mut [u8]) {
    for ((s, o), d) in src.chunks_exact(4).zip(ov.chunks_exact(4)).zip(out.chunks_exact_mut(4)) {
        let a = o[3] as u32;
        if a == 0 {
            d.copy_from_slice(s);
        } else {
            for c in 0..3 {
                d[c] = ((o[c] as u32 * a + s[c] as u32 * (255 - a) + 127) / 255) as u8;
            }
            d[3] = 255;
        }
    }
}

pub fn run(req: Req, work: &Path, cancel: Arc<AtomicBool>, emit: impl Fn(Progress)) -> Result<PathBuf, String> {
    let out_dir = PathBuf::from(&req.out_dir);
    if !out_dir.is_dir() {
        return Err("保存先フォルダーが見つかりません".into());
    }
    if !Path::new(&req.source).is_file() {
        return Err(format!("元動画が見つかりません（{}）。元の場所に戻してから再試行してください", req.source));
    }
    let tmp_out = out_dir.join(format!(".{}.part", req.file_name));
    let result = (|| {
        // 1. source audio track
        let src_audio = work.join("source_audio.pcm");
        let use_src = req.has_audio && req.source_gain > 0.0;
        if use_src {
            build_source_audio(&req, &src_audio, &cancel, &|r| emit(Progress { phase: "audio", ratio: r }))?;
        }
        // 2. encoder
        let enc = ff::h264_encoder();
        let mut cmd = ff::cmd();
        cmd.args(["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", &format!("{W}x{H}"), "-r", "30", "-i", "-"]);
        cmd.args(["-i", &req.commentary]);
        let voice = format!("[1:a]aresample=48000,aformat=channel_layouts=stereo,volume={:.3},apad[v]", req.voice_gain);
        let graph = if use_src {
            cmd.args(["-f", "s16le", "-ar", "48000", "-ac", "2", "-i"]).arg(&src_audio);
            format!("{voice};[2:a]volume={:.3}[s];[v][s]amix=inputs=2:duration=longest:normalize=0[a]", req.source_gain)
        } else {
            voice.replace("[v]", "[a]")
        };
        cmd.args(["-filter_complex", &graph, "-map", "0:v", "-map", "[a]"]);
        cmd.args(enc.args(""));
        cmd.args(["-r", "30", "-c:a", "aac", "-b:a", "192k", "-t", &format!("{:.3}", req.duration), "-movflags", "+faststart", "-f", "mp4"]);
        cmd.arg(&tmp_out).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("FFmpegを起動できません: {e}"))?;
        let log = Arc::new(Mutex::new(String::new()));
        let mut se = child.stderr.take().unwrap();
        let log2 = log.clone();
        let log_thread = std::thread::spawn(move || {
            let mut b = [0u8; 4096];
            while let Ok(n) = se.read(&mut b) {
                if n == 0 {
                    break;
                }
                let mut l = log2.lock().unwrap();
                l.push_str(&String::from_utf8_lossy(&b[..n]));
                if l.len() > 8000 {
                    let cut = l.len() - 4000;
                    let cut = (cut..l.len()).find(|&i| l.is_char_boundary(i)).unwrap_or(0);
                    l.drain(..cut);
                }
            }
        });
        let mut stdin = child.stdin.take().unwrap();
        let frames = (req.duration * FPS).ceil() as u64;
        let mut reader = Reader::new(&req.source, req.src_fps, req.src_duration, req.color_tagged);
        let mut ov: Option<(Vec<u8>, bool)> = None;
        let mut oi = 0;
        let mut si = 0;
        let mut out = vec![0u8; W * H * 4];
        let black = vec![0u8; W * H * 4];
        let fail = |child: &mut Child, msg: String| {
            let _ = child.kill();
            let _ = child.wait();
            msg
        };
        for f in 0..frames {
            if cancel.load(Ordering::Relaxed) {
                return Err(fail(&mut child, "cancelled".into()));
            }
            while oi < req.overlays.len() && req.overlays[oi].frame <= f {
                ov = match &req.overlays[oi].file {
                    Some(p) => Some(load_png(p).map_err(|e| fail(&mut child, e))?),
                    None => None,
                };
                oi += 1;
            }
            let t = f as f64 / FPS;
            while si + 1 < req.segs.len() && req.segs[si + 1].t <= t {
                si += 1;
            }
            let s = &req.segs[si];
            let data: &[u8] = match &ov {
                Some((o, true)) => o,
                _ if s.board => ov.as_ref().map_or(&black[..], |(o, _)| &o[..]),
                _ => {
                    let p = if s.playing { s.pos + (t - s.t) * s.rate } else { s.pos };
                    let p = p.clamp(0.0, (req.src_duration - 1.0 / req.src_fps).max(0.0));
                    let frame = reader.frame_at(p).map_err(|e| fail(&mut child, e))?;
                    match &ov {
                        Some((o, _)) => {
                            blend(frame, o, &mut out);
                            &out
                        }
                        None => frame,
                    }
                }
            };
            if stdin.write_all(data).is_err() {
                break; // encoder died; reported below
            }
            if f % 15 == 0 {
                emit(Progress { phase: "video", ratio: f as f64 / frames as f64 });
            }
        }
        drop(stdin);
        drop(reader);
        emit(Progress { phase: "finalize", ratio: 1.0 });
        let status = child.wait().map_err(|e| e.to_string())?;
        let _ = log_thread.join();
        if !status.success() {
            let l = log.lock().unwrap();
            let tail: Vec<&str> = l.lines().rev().take(6).collect();
            return Err(format!("エンコードに失敗しました ({}): {}", enc.name, tail.into_iter().rev().collect::<Vec<_>>().join(" / ")));
        }
        if std::fs::metadata(&tmp_out).map(|m| m.len()).unwrap_or(0) == 0 {
            return Err("出力ファイルが作成されませんでした".into());
        }
        let fin = unique_path(&out_dir, &req.file_name);
        std::fs::rename(&tmp_out, &fin).map_err(|e| format!("ファイルを確定できません: {e}"))?;
        Ok(fin)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_out);
    }
    let _ = std::fs::remove_dir_all(work);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blend_and_unique() {
        let src = [10u8, 20, 30, 255, 10, 20, 30, 255];
        let ov = [200u8, 100, 0, 0, 250, 0, 0, 255];
        let mut out = [0u8; 8];
        blend(&src, &ov, &mut out);
        assert_eq!(out, [10, 20, 30, 255, 250, 0, 0, 255]);

        let d = std::env::temp_dir().join("satoimo_unique_test");
        let _ = std::fs::create_dir_all(&d);
        std::fs::write(d.join("a_commentary.mp4"), b"x").unwrap();
        let _ = std::fs::remove_file(d.join("a_commentary_2.mp4"));
        assert_eq!(unique_path(&d, "a_commentary.mp4"), d.join("a_commentary_2.mp4"));
        assert_eq!(unique_path(&d, "b_commentary.mp4"), d.join("b_commentary.mp4"));
    }
}
