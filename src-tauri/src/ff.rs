// Bundled ffmpeg sidecar helpers.
use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

pub fn path() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent().unwrap().join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })
}

/// Untagged sources are interpreted as BT.709 (what Chromium/WebKit assume for HD video).
pub const ASSUME_709: &str = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709,";

pub fn cmd() -> Command {
    let mut c = Command::new(path());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    c
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub fps: f64,
    pub duration: f64,
    pub codec: String,
    pub has_audio: bool,
    /// false when the stream carries no color matrix tag (then it is read as BT.709 like the WebView does)
    pub color_tagged: bool,
}

/// Parses `ffmpeg -i` stream info (we ship ffmpeg only, not ffprobe).
pub fn probe(path: &str) -> Result<Probe, String> {
    let mut c = cmd();
    c.args(["-loglevel", "info", "-i", path]).stdout(Stdio::null()).stderr(Stdio::piped());
    let out = c.output().map_err(|e| format!("FFmpegを起動できません: {e}"))?;
    parse_probe(&String::from_utf8_lossy(&out.stderr))
}

fn parse_probe(s: &str) -> Result<Probe, String> {
    let video = s.lines().find(|l| l.contains("Stream #") && l.contains(": Video: ") && !l.contains("attached pic"));
    let Some(video) = video else {
        return Err("動画として読み込めないファイルです（対応形式の例: MP4・MOV）。".into());
    };
    let codec = video.split(": Video: ").nth(1).and_then(|r| r.split([' ', ',']).next()).unwrap_or("").to_string();
    let num_before = |key: &str| {
        video.split(", ").find_map(|p| p.strip_suffix(key).and_then(|n| n.trim().parse::<f64>().ok()))
    };
    let fps = num_before(" fps").or_else(|| num_before(" tbr")).filter(|f| *f > 0.0 && *f < 1000.0).unwrap_or(30.0);
    let duration = s
        .lines()
        .find_map(|l| l.trim().strip_prefix("Duration: "))
        .and_then(|d| {
            let hms = d.split(',').next()?;
            let mut it = hms.split(':').map(|x| x.parse::<f64>().ok());
            Some(it.next()?? * 3600.0 + it.next()?? * 60.0 + it.next()??)
        })
        .unwrap_or(0.0);
    let has_audio = s.lines().any(|l| l.contains("Stream #") && l.contains(": Audio: "));
    let color_tagged = ["bt709", "bt470bg", "smpte170m", "bt2020", "smpte240m"].iter().any(|m| video.contains(m));
    Ok(Probe { fps, duration, codec, has_audio, color_tagged })
}

pub struct Encoder {
    pub name: &'static str,
}

impl Encoder {
    /// `pre`: filters to run before the color conversion (e.g. "scale=...,"), may be empty.
    pub fn args(&self, pre: &str) -> Vec<String> {
        let pix = if self.name == "libopenh264" { "yuv420p" } else { "nv12" };
        // BT.709 is what players (and the WebView preview) assume for HD; tag it explicitly
        let vf = format!("{pre}scale=out_color_matrix=bt709:out_range=tv,format={pix},setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv");
        let mut a: Vec<String> = vec!["-vf", &vf, "-c:v", self.name, "-pix_fmt", pix, "-b:v", "10M", "-maxrate", "14M", "-bufsize", "20M", "-g", "60"].into_iter().map(String::from).collect();
        a.extend(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"].map(String::from));
        if self.name == "h264_videotoolbox" {
            a.extend(["-allow_sw", "1"].map(String::from));
        }
        a
    }
}

/// First H.264 encoder that actually works on this machine (hardware first, software last).
pub fn h264_encoder() -> &'static Encoder {
    static E: OnceLock<Encoder> = OnceLock::new();
    E.get_or_init(|| {
        let candidates: &[&'static str] = if cfg!(target_os = "macos") {
            &["h264_videotoolbox", "libopenh264"]
        } else {
            &["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf", "libopenh264"]
        };
        for &name in candidates {
            let e = Encoder { name };
            let mut c = cmd();
            c.args(["-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30", "-frames:v", "5"]);
            c.args(e.args("")).args(["-f", "null", "-"]).stdout(Stdio::null()).stderr(Stdio::null());
            if c.status().map(|s| s.success()).unwrap_or(false) {
                return e;
            }
        }
        Encoder { name: "libopenh264" }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse() {
        let s = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':\n  Duration: 00:01:02.50, start: 0.000000, bitrate: 5000 kb/s\n  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4800 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s (default)\n";
        let p = super::parse_probe(s).unwrap();
        assert_eq!(p.codec, "h264");
        assert!((p.fps - 29.97).abs() < 1e-9);
        assert!((p.duration - 62.5).abs() < 1e-9);
        assert!(p.has_audio);
        assert!(p.color_tagged);
        assert!(!super::parse_probe("  Stream #0:0: Video: h264, yuv420p(progressive), 1920x1080, 30 fps
").unwrap().color_tagged);
        assert!(super::parse_probe("Input #0, wav\n  Stream #0:0: Audio: pcm_s16le\n").is_err());
    }
}
