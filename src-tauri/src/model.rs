use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fingerprint {
    pub size_bytes: u64,
    pub modified_at_ms: u64,
    pub head_tail_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub absolute_path: String,
    pub relative_path: Option<String>,
    pub fingerprint: Fingerprint,
    pub duration_us: u64,
    pub width: u32,
    pub height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub has_audio: bool,
    pub rotation_degrees: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    pub status: String,
    pub relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mix {
    pub microphone_gain: f64,
    pub source_gain: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pen {
    pub color: String,
    pub width_normalized: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiState {
    pub right_panel_collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeInfo {
    pub id: String,
    pub duration_us: u64,
    pub events_path: String,
    pub audio_path: String,
    pub recovered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub app_version: String,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub project_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub source: SourceInfo,
    #[serde(default)]
    pub media_url: String,
    #[serde(default)]
    pub audio_url: String,
    pub proxy: ProxyInfo,
    pub mix: Mix,
    pub pen: Pen,
    pub take: Option<TakeInfo>,
    pub last_source_position_us: u64,
    pub ui: UiState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub schema_version: u32,
    pub seq: u64,
    pub session_us: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub sample_format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    pub project_path: String,
    pub project_name: String,
    pub audio_bytes: u64,
    pub valid_event_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub percent: f64,
    pub elapsed_us: u64,
    pub remaining_us: Option<u64>,
    pub output_path: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OutputSegment {
    Play {
        output_start_us: u64,
        output_duration_us: u64,
        source_start_us: u64,
        source_end_us: u64,
        rate: f64,
    },
    Freeze {
        output_start_us: u64,
        output_duration_us: u64,
        source_frame_us: u64,
    },
}

impl OutputSegment {
    pub fn duration_us(&self) -> u64 {
        match self {
            Self::Play {
                output_duration_us, ..
            }
            | Self::Freeze {
                output_duration_us, ..
            } => *output_duration_us,
        }
    }
}
