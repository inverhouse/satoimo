use crate::model::{OutputSegment, SessionEvent};

pub fn build(events: &[SessionEvent]) -> Result<Vec<OutputSegment>, String> {
    let first = events.first().ok_or("イベントがありません。")?;
    if first.event_type != "session_start" {
        return Err("先頭イベントがsession_startではありません。".into());
    }
    let mut playing = false;
    let mut source_us = number(&first.payload, "sourceUs").unwrap_or(0) as f64;
    let mut rate = float(&first.payload, "rate").unwrap_or(1.0);
    let mut session_us = first.session_us;
    let mut segments = Vec::new();
    for event in events.iter().skip(1) {
        let elapsed = event.session_us.saturating_sub(session_us);
        if elapsed > 0 {
            if playing {
                let end = source_us + elapsed as f64 * rate;
                segments.push(OutputSegment::Play {
                    output_start_us: session_us,
                    output_duration_us: elapsed,
                    source_start_us: source_us.round() as u64,
                    source_end_us: end.round() as u64,
                    rate,
                });
                source_us = end;
            } else {
                segments.push(OutputSegment::Freeze {
                    output_start_us: session_us,
                    output_duration_us: elapsed,
                    source_frame_us: source_us.round() as u64,
                });
            }
        }
        match event.event_type.as_str() {
            "play" => {
                source_us = number(&event.payload, "sourceUs").unwrap_or(source_us as u64) as f64;
                rate = float(&event.payload, "rate").unwrap_or(rate);
                playing = true;
            }
            "pause" => {
                source_us = number(&event.payload, "sourceUs").unwrap_or(source_us as u64) as f64;
                playing = false;
            }
            "seek" => {
                source_us = number(&event.payload, "toSourceUs").unwrap_or(source_us as u64) as f64;
                playing = event
                    .payload
                    .get("continuesPlaying")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
            "rate_change" => {
                source_us = number(&event.payload, "sourceUs").unwrap_or(source_us as u64) as f64;
                rate = float(&event.payload, "toRate").unwrap_or(rate);
                playing = event
                    .payload
                    .get("playing")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
            "session_stop" | "interruption" => playing = false,
            _ => {}
        }
        session_us = event.session_us;
    }
    Ok(segments)
}

fn number(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}
fn float(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn e(seq: u64, session_us: u64, kind: &str, payload: serde_json::Value) -> SessionEvent {
        SessionEvent {
            schema_version: 1,
            seq,
            session_us,
            event_type: kind.into(),
            payload,
        }
    }
    #[test]
    fn play_pause_seek_rate_are_reconstructed() {
        let result = build(&[
            e(
                1,
                0,
                "session_start",
                json!({"sourceUs":2_000_000,"rate":1.0}),
            ),
            e(
                2,
                3_000_000,
                "play",
                json!({"sourceUs":2_000_000,"rate":1.0}),
            ),
            e(
                3,
                5_000_000,
                "seek",
                json!({"toSourceUs":0,"continuesPlaying":true}),
            ),
            e(
                4,
                7_000_000,
                "rate_change",
                json!({"sourceUs":2_000_000,"toRate":0.5,"playing":true}),
            ),
            e(5, 9_000_000, "session_stop", json!({})),
        ])
        .unwrap();
        assert_eq!(
            result[0],
            OutputSegment::Freeze {
                output_start_us: 0,
                output_duration_us: 3_000_000,
                source_frame_us: 2_000_000
            }
        );
        assert_eq!(
            result[3],
            OutputSegment::Play {
                output_start_us: 7_000_000,
                output_duration_us: 2_000_000,
                source_start_us: 2_000_000,
                source_end_us: 3_000_000,
                rate: 0.5
            }
        );
    }
    #[test]
    fn all_rates_calculate_source_duration() {
        for rate in [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0] {
            let result = build(&[
                e(1, 0, "session_start", json!({"sourceUs":0,"rate":rate})),
                e(2, 0, "play", json!({"sourceUs":0,"rate":rate})),
                e(3, 4_000_000, "session_stop", json!({})),
            ])
            .unwrap();
            match result[0] {
                OutputSegment::Play { source_end_us, .. } => {
                    assert_eq!(source_end_us, (4_000_000.0 * rate) as u64)
                }
                _ => panic!(),
            }
        }
    }
}
