// Microphone capture: cpal stream on its own thread (Stream is !Send on some hosts),
// samples go through a channel to a writer thread that streams mono i16 WAV to disk.
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

type Wav = hound::WavWriter<BufWriter<File>>;

pub struct Mic {
    pub name: String,
    pub rate: u32,
    level: Arc<AtomicU32>,
    /// first unrecoverable problem (device lost, WAV write failed); recording stops on it
    fault: Arc<Mutex<Option<String>>>,
    rec: Arc<Mutex<Option<(Wav, Instant)>>>,
    stop: mpsc::Sender<()>,
}

#[derive(Serialize)]
pub struct MicInfo {
    pub id: String,
    pub name: String,
}

pub fn list() -> Vec<MicInfo> {
    let host = cpal::default_host();
    let Ok(devs) = host.input_devices() else { return vec![] };
    devs.filter_map(|d| {
        let id = d.id().ok()?.to_string();
        let name = d.description().map(|x| x.name().to_string()).unwrap_or_else(|_| id.clone());
        Some(MicInfo { id, name })
    })
    .collect()
}

impl Mic {
    pub fn open(id: Option<String>) -> Result<Mic, String> {
        let level = Arc::new(AtomicU32::new(0));
        let fault: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let rec: Arc<Mutex<Option<(Wav, Instant)>>> = Arc::new(Mutex::new(None));
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(String, u32), String>>();
        let (data_tx, data_rx) = mpsc::channel::<Vec<i16>>();

        // writer thread: ends when the stream thread drops data_tx
        let (rec_w, fault_w) = (rec.clone(), fault.clone());
        std::thread::spawn(move || {
            for buf in data_rx {
                let mut g = rec_w.lock().unwrap();
                let Some((w, last)) = g.as_mut() else { continue };
                let mut r = buf.into_iter().try_for_each(|s| w.write_sample(s));
                // flush() rewrites the header, so a crash loses at most ~1s
                if r.is_ok() && last.elapsed() > Duration::from_secs(1) {
                    r = w.flush();
                    *last = Instant::now();
                }
                if let Err(e) = r {
                    // stop writing; what reached the disk is recovered by repair_wav
                    drop(g.take()); // its Drop tries a last header update; errors are ignored
                    set_fault(&fault_w, format!("録音ファイルを保存できませんでした（ディスクの空き容量を確認してください）: {e}"));
                }
            }
        });

        let (lv, fl) = (level.clone(), fault.clone());
        std::thread::spawn(move || {
            let r = (|| -> Result<(cpal::Stream, String, u32), String> {
                let host = cpal::default_host();
                let dev = match id {
                    Some(id) => {
                        let id = id.parse().map_err(|_| "マイクが見つかりません".to_string())?;
                        host.device_by_id(&id)
                    }
                    None => host.default_input_device(),
                }
                .ok_or("使用できるマイクがありません")?;
                let name = dev.description().map(|x| x.name().to_string()).unwrap_or_default();
                let cfg = dev.default_input_config().map_err(|e| format!("マイクを開けません: {e}"))?;
                let ch = cfg.channels() as usize;
                let rate = cfg.sample_rate() as u32;
                let fmt = cfg.sample_format();
                let err_fl = fl.clone();
                // rerouting / xruns are recoverable; only a lost or denied device is a failure
                let err = move |e: cpal::Error| {
                    if !matches!(e.kind(), cpal::ErrorKind::DeviceChanged | cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied) {
                        set_fault(&err_fl, format!("マイクが使用できなくなりました（接続を確認してください）: {e}"));
                    }
                };
                macro_rules! build {
                    ($t:ty) => {
                        dev.build_input_stream(
                            cfg.into(),
                            move |data: &[$t], _: &_| {
                                let mut out = Vec::with_capacity(data.len() / ch);
                                let mut peak = 0f32;
                                for frame in data.chunks(ch) {
                                    let v: f32 = frame.iter().map(|s| cpal::Sample::to_sample::<f32>(*s)).sum::<f32>() / ch as f32;
                                    peak = peak.max(v.abs());
                                    out.push((v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                                }
                                let old = f32::from_bits(lv.load(Ordering::Relaxed));
                                if peak > old {
                                    lv.store(peak.to_bits(), Ordering::Relaxed);
                                }
                                let _ = data_tx.send(out);
                            },
                            err,
                            None,
                        )
                    };
                }
                let stream = match fmt {
                    cpal::SampleFormat::I16 => build!(i16),
                    cpal::SampleFormat::I32 => build!(i32),
                    cpal::SampleFormat::U16 => build!(u16),
                    cpal::SampleFormat::F32 => build!(f32),
                    f => return Err(format!("未対応の音声形式です: {f}")),
                }
                .map_err(|e| format!("マイクを開けません: {e}"))?;
                stream.play().map_err(|e| format!("マイクを開始できません: {e}"))?;
                Ok((stream, name, rate))
            })();
            match r {
                Ok((stream, name, rate)) => {
                    let _ = ready_tx.send(Ok((name, rate)));
                    let _ = stop_rx.recv();
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        });
        let (name, rate) = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "マイクが応答しません".to_string())??;
        Ok(Mic { name, rate, level, fault, rec, stop: stop_tx })
    }

    /// Peak since last call (0..1), and the fault message once recording can't continue.
    pub fn level(&self) -> (f32, Option<String>) {
        (f32::from_bits(self.level.swap(0, Ordering::Relaxed)), self.fault())
    }

    pub fn fault(&self) -> Option<String> {
        self.fault.lock().unwrap().clone()
    }

    pub fn start(&self, path: &Path) -> Result<(), String> {
        let spec = hound::WavSpec { channels: 1, sample_rate: self.rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let w = hound::WavWriter::create(path, spec).map_err(|e| format!("録音ファイルを作れません: {e}"))?;
        *self.rec.lock().unwrap() = Some((w, Instant::now()));
        Ok(())
    }

    /// Finalizes the current WAV; returns its length in seconds.
    pub fn stop(&self) -> Result<f64, String> {
        let Some((w, _)) = self.rec.lock().unwrap().take() else { return Ok(0.0) };
        let secs = w.duration() as f64 / self.rate as f64;
        w.finalize().map_err(|e| e.to_string())?;
        Ok(secs)
    }
}

impl Drop for Mic {
    fn drop(&mut self) {
        let _ = self.stop();
        let _ = self.stop.send(());
    }
}

fn set_fault(f: &Mutex<Option<String>>, msg: String) {
    f.lock().unwrap().get_or_insert(msg);
}

/// Fixes RIFF/data sizes of a WAV whose writer died, using the real file length.
/// Assumes the 44-byte header hound writes for mono PCM16. Returns seconds of audio.
pub fn repair_wav(path: &Path) -> Result<f64, String> {
    let mut f = OpenOptions::new().read(true).write(true).open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mut h = [0u8; 44];
    f.read_exact(&mut h).map_err(|_| "録音ファイルが壊れています".to_string())?;
    if &h[0..4] != b"RIFF" || &h[36..40] != b"data" {
        return Err("録音ファイルの形式が不正です".into());
    }
    let rate = u32::from_le_bytes([h[24], h[25], h[26], h[27]]).max(1);
    let data = (len - 44) & !1;
    f.seek(SeekFrom::Start(4)).unwrap();
    f.write_all(&((data + 36) as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(40)).unwrap();
    f.write_all(&(data as u32).to_le_bytes()).map_err(|e| e.to_string())?;
    f.set_len(44 + data).map_err(|e| e.to_string())?;
    Ok(data as f64 / 2.0 / rate as f64)
}

#[cfg(test)]
mod tests {
    #[test]
    fn repair_truncated_wav() {
        let p = std::env::temp_dir().join("satoimo_repair_test.wav");
        let spec = hound::WavSpec { channels: 1, sample_rate: 48000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&p, spec).unwrap();
        for i in 0..48000 {
            w.write_sample((i % 100) as i16).unwrap();
        }
        w.flush().unwrap();
        // simulate a crash after the last periodic flush: header says 1s, then raw data follows
        std::mem::forget(w);
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        std::io::Write::write_all(&mut f, &vec![0u8; 48000]).unwrap();
        drop(f);
        let secs = super::repair_wav(&p).unwrap();
        assert!((secs - 1.5).abs() < 1e-9, "{secs}");
        assert_eq!(hound::WavReader::open(&p).unwrap().duration(), 72000);
    }
}
