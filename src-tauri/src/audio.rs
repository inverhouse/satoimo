use crate::{model::InputDevice, project::Result};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat, Stream, StreamConfig,
};
use crossbeam_channel::{bounded, Sender};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

enum Samples {
    F32(Vec<f32>),
    I16(Vec<i16>),
    U16(Vec<u16>),
    Stop,
}

pub struct AudioCapture {
    stream: Option<Stream>,
    sender: Sender<Samples>,
    writer: Option<JoinHandle<Result<()>>>,
    part_path: PathBuf,
}

// CPAL streams are owned and dropped only on the command thread through the state mutex.
unsafe impl Send for AudioCapture {}

pub fn devices() -> Result<Vec<InputDevice>> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let list = host
        .input_devices()
        .map_err(|e| format!("MIC_UNAVAILABLE: 入力デバイスを取得できません: {e}"))?;
    Ok(list
        .enumerate()
        .filter_map(|(index, device)| {
            let name = device.name().ok()?;
            let config = device.default_input_config().ok()?;
            Some(InputDevice {
                id: index.to_string(),
                is_default: Some(&name) == default_name.as_ref(),
                name,
                sample_rate: config.sample_rate().0,
                channels: config.channels(),
                sample_format: config.sample_format().to_string(),
            })
        })
        .collect())
}

pub fn start(
    project_path: &Path,
    device_id: &str,
    app: AppHandle,
) -> Result<(AudioCapture, serde_json::Value)> {
    let index: usize = device_id
        .parse()
        .map_err(|_| "MIC_UNAVAILABLE: マイクIDが不正です。".to_string())?;
    let host = cpal::default_host();
    let device = host
        .input_devices()
        .map_err(|e| format!("MIC_UNAVAILABLE: {e}"))?
        .nth(index)
        .ok_or_else(|| "MIC_UNAVAILABLE: 選択したマイクが見つかりません。".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("MIC_UNAVAILABLE: マイク形式を取得できません: {e}"))?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.config();
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate.0;
    let part_path = project_path.join("audio/take-current.wav.part");
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let (sender, receiver) = bounded::<Samples>(32);
    let output = part_path.clone();
    let writer = thread::spawn(move || -> Result<()> {
        let mut wav = hound::WavWriter::create(&output, spec)
            .map_err(|e| format!("音声ファイルを作成できません: {e}"))?;
        while let Ok(samples) = receiver.recv() {
            match samples {
                Samples::F32(values) => write_mono(
                    &mut wav,
                    &values
                        .iter()
                        .map(|v| (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                        .collect::<Vec<_>>(),
                    channels,
                )?,
                Samples::I16(values) => write_mono(&mut wav, &values, channels)?,
                Samples::U16(values) => write_mono(
                    &mut wav,
                    &values
                        .iter()
                        .map(|v| (*v as i32 - i16::MAX as i32 - 1) as i16)
                        .collect::<Vec<_>>(),
                    channels,
                )?,
                Samples::Stop => break,
            }
        }
        wav.finalize()
            .map_err(|e| format!("WAVを確定できません: {e}"))?;
        Ok(())
    });
    let overflowed = Arc::new(AtomicBool::new(false));
    let error_app = app.clone();
    let error = move |err| {
        let _ = error_app.emit("recording-error", format!("MIC_DISCONNECTED: {err}"));
    };
    let stream = match format {
        SampleFormat::F32 => build_stream(
            &device,
            &config,
            sender.clone(),
            overflowed.clone(),
            app,
            error,
            |v: &[f32]| Samples::F32(v.to_vec()),
            meter_f32,
        ),
        SampleFormat::I16 => build_stream(
            &device,
            &config,
            sender.clone(),
            overflowed.clone(),
            app,
            error,
            |v: &[i16]| Samples::I16(v.to_vec()),
            meter_i16,
        ),
        SampleFormat::U16 => build_stream(
            &device,
            &config,
            sender.clone(),
            overflowed.clone(),
            app,
            error,
            |v: &[u16]| Samples::U16(v.to_vec()),
            meter_u16,
        ),
        other => {
            return Err(format!(
                "MIC_UNAVAILABLE: 未対応のsample formatです: {other}"
            ))
        }
    }
    .map_err(|e| {
        format!("MIC_PERMISSION: マイクを開始できません。OS設定で権限を確認してください: {e}")
    })?;
    stream
        .play()
        .map_err(|e| format!("MIC_UNAVAILABLE: マイクを再生できません: {e}"))?;
    let info = serde_json::json!({"sampleRate":sample_rate,"channels":1,"sampleFormat":"i16","sourceChannels":channels});
    Ok((
        AudioCapture {
            stream: Some(stream),
            sender,
            writer: Some(writer),
            part_path,
        },
        info,
    ))
}

fn build_stream<T: cpal::SizedSample + Send + 'static>(
    device: &cpal::Device,
    config: &StreamConfig,
    sender: Sender<Samples>,
    overflowed: Arc<AtomicBool>,
    app: AppHandle,
    error: impl FnMut(cpal::StreamError) + Send + 'static,
    wrap: impl Fn(&[T]) -> Samples + Send + 'static,
    measure: impl Fn(&[T]) -> (f32, f32) + Send + 'static,
) -> std::result::Result<Stream, cpal::BuildStreamError> {
    let mut last_meter = Instant::now()
        .checked_sub(Duration::from_millis(50))
        .unwrap_or_else(Instant::now);
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            if last_meter.elapsed() >= Duration::from_millis(50) {
                let (rms, peak) = measure(data);
                let _ = app.emit("mic-level", serde_json::json!({"rms":rms,"peak":peak}));
                last_meter = Instant::now();
            }
            if sender.try_send(wrap(data)).is_err() && !overflowed.swap(true, Ordering::SeqCst) {
                let _ = app.emit(
                    "recording-error",
                    "MIC_DISCONNECTED: 音声buffer overflowのため収録を安全停止しました。",
                );
            }
        },
        error,
        None,
    )
}

fn calculate_meter(samples: impl Iterator<Item = f32>, count: usize) -> (f32, f32) {
    if count == 0 {
        return (0.0, 0.0);
    }
    let mut squares = 0.0;
    let mut peak = 0.0f32;
    for sample in samples {
        let value = sample.abs().min(1.0);
        squares += value * value;
        peak = peak.max(value);
    }
    ((squares / count as f32).sqrt(), peak)
}
fn meter_f32(data: &[f32]) -> (f32, f32) {
    calculate_meter(data.iter().copied(), data.len())
}
fn meter_i16(data: &[i16]) -> (f32, f32) {
    calculate_meter(data.iter().map(|v| *v as f32 / i16::MAX as f32), data.len())
}
fn meter_u16(data: &[u16]) -> (f32, f32) {
    calculate_meter(
        data.iter().map(|v| (*v as f32 - 32768.0) / 32768.0),
        data.len(),
    )
}
fn write_mono(
    writer: &mut hound::WavWriter<std::io::BufWriter<std::fs::File>>,
    values: &[i16],
    channels: usize,
) -> Result<()> {
    for frame in values.chunks(channels) {
        let sum: i32 = frame.iter().map(|v| *v as i32).sum();
        writer
            .write_sample((sum / frame.len().max(1) as i32) as i16)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl AudioCapture {
    pub fn finish(mut self) -> Result<PathBuf> {
        self.stream.take();
        let _ = self.sender.send(Samples::Stop);
        if let Some(writer) = self.writer.take() {
            writer
                .join()
                .map_err(|_| "音声writer threadが異常終了しました。".to_string())??;
        }
        let final_path = self.part_path.with_file_name("take-current.wav");
        std::fs::rename(&self.part_path, &final_path)
            .map_err(|e| format!("WAVを確定できません: {e}"))?;
        Ok(final_path)
    }
}
