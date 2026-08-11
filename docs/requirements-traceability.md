# 要件対応表

| 要件 | 実装 | 検証 |
| --- | --- | --- |
| AC-01 基本収録 | `RecordScreen`、`start_session`、CPAL `AudioCapture`。開始直後は`RECORDING_PAUSED` | UI手動試験、Rust/TS build |
| AC-02 巻き戻し | `seek`イベントと`timeline::build` | `timeline.test.ts`、Rust timeline test |
| AC-03 停止 | freeze segmentとsource audio silence | timeline unit、fixture integration script |
| AC-04 速度 | 固定7速度、`atempo`、quarter speed chain | 7速度parameterized unit、export unit |
| AC-05 描画 | 正規化Canvas座標、stroke begin/point/end/hide、再生開始時の自動非表示、ASS vector | TS stroke visibility unit、手動出力確認 |
| AC-06 終了 | 1秒の`HoldController`、pointer/key cancel、single-fire guard | Hold unit、UI手動0.9/1.0秒試験 |
| AC-07 出力 | FFmpeg filter script、H.264/AAC、1080p30、yuv420p、faststart | `ffprobe` acceptance script、実出力試験 |
| AC-08 音量 | project mix 1.0/0.20、FFmpeg `volume`/`amix` | project既定値のRustテスト、実出力waveform確認 |
| AC-09 同期 | Rust monotonic `Instant`、sample count WAV、session duration trim/pad | 30分実機試験 |
| AC-10 復旧 | JSONL末尾切捨て、WAV header修復、interruption追加 | Rust truncated-tail unit、強制終了手動試験 |
| AC-11 メモリ | video protocol range、bounded audio channel、逐次JSONL/WAV | 30分・8GB実機working set計測 |
| AC-12 OS | 共通React UI、Tauri 2、CPAL、OS別bundle設定 | Windows/macOS build matrix（手動） |
| AC-13 安全な失敗 | `.part`→rename、backup、recovery退避、export cancel | Rust part-path unit、障害注入手動試験 |

## MUST機能の配置

| 領域 | 主な実装ファイル |
| --- | --- |
| project、fingerprint、atomic save、lock、recent | `src-tauri/src/project.rs` |
| token allowlist、GET/HEAD/単一Range | `src-tauri/src/lib.rs` |
| ffprobe解析、proxy判定・生成 | `project.rs`、`export.rs`、`ProxyScreen.tsx` |
| monotonic session clock、JSONL追記・検証 | `events.rs` |
| CPAL録音、bounded buffer、mono PCM WAV、meter | `audio.rs` |
| playback、shortcut、15Hz固定の左右キーframe step、1秒hold stop | `RecordScreen.tsx`、`Transport.tsx`、`hold.ts` |
| normalized Canvas drawing | `DrawingCanvas.tsx` |
| virtual preview timeline | `timeline.rs`、`timeline.ts`、`ReviewScreen.tsx` |
| FFmpeg segment/audio mix/ASS/export/progress/cancel | `export.rs`、`ExportScreen.tsx` |
| crash recovery | `recovery.rs`、`RecoveryScreen.tsx` |
| accessibility | visible labels、aria-label、focus styles、Modal Esc、reduced-motion CSS |
| fixture、自動test | `scripts/generate-fixtures.mjs`、`scripts/acceptance-smoke.mjs`、`src/**/*.test.ts`、Rust `#[test]` |

## 手動プラットフォーム試験

Windows 10 x64 8GB、Windows 11 x64、Apple Silicon 8GBでそれぞれ、1080p60・30分素材を使い、録音、再生中seek、10秒freeze、全速度、描画と消去、1秒長押し、強制終了復旧、書き出しcancel/retry、完成動画のffprobe、音声同期、working setを記録します。WindowsではWebView2導入済み/未導入、macOSでは初回マイク権限とVideoToolbox fallbackも確認します。
