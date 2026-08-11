# さといも

スポーツチームの練習動画を見ながら、マイク実況とフリーハンド描画を後付け収録するローカルデスクトップアプリです。再生、停止、巻き戻し、速度変更をイベントとして保存し、画面収録を使わずに1920×1080・30fpsのMP4を再構成します。UI、通知、通常のマウスカーソルは完成動画へ入りません。

## 対応環境

- Windows 10/11 x64（WebView2 Runtime）
- Apple Silicon macOS 13以降
- RAM 8GB以上、画面1100×700以上
- FFmpeg 7以降（`libass`の`ass` filter、H.264 encoder、AAC encoderを含むbuild）
- Node.js 22以降、Rust stable、OSごとのTauri 2 prerequisites

Linux、Intel Mac、Windows ARMは対象外です。ユーザーデータの外部送信、telemetry、自動更新はありません。

## 開発

```bash
npm install
npm run tauri dev
```

FFmpeg/ffprobeがPATHにない場合は次の環境変数を設定します。

```bash
SATOIMO_FFMPEG_PATH=/path/to/ffmpeg \
SATOIMO_FFPROBE_PATH=/path/to/ffprobe \
npm run tauri dev
```

macOSで初めて録音するときは、表示されたダイアログでマイクを許可してください。拒否した場合は「システム設定 → プライバシーとセキュリティ → マイク」で「さといも」を有効にします。Windowsでは「設定 → プライバシーとセキュリティ → マイク」でデスクトップアプリのアクセスを有効にします。

## テスト

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run fixtures
npm run test:acceptance
```

`npm run fixtures`はFFmpegで10秒の1080p60素材、VFR、音声なし、回転metadata、既知の実況WAVを`test-fixtures/generated/`へ生成します。実動画や実音声はテスト結果・ログ・リポジトリへ保存しません。

Windows 10/11とApple Silicon macOSの30分実機試験は、各OSの実機で[要件対応表](docs/requirements-traceability.md)の手動試験を実行してください。現在の開発環境だけでは他OSの配布物やマイク権限フローを検証できません。

## 配布ビルド

`prepare:sidecars`はPATHまたは上記環境変数で指定したFFmpeg/ffprobeを、Tauriが要求するtarget triple名で`src-tauri/binaries/`へコピーします。

```bash
npm run prepare:sidecars
npm run tauri build
```

- Apple Silicon Macでは`.app`と`.dmg`を生成します。Developer IDは外部のTauri署名環境変数で設定できます。未署名・未公証buildはFinderでアプリをControl-clickし「開く」を選択してください。
- Windows x64ではNSIS/MSI相当の設定をOS上で生成します。WebView2がない端末ではinstallerがbootstrapperを取得します。未署名buildではSmartScreenの「詳細情報 → 実行」が必要な場合があります。
- Windows artifactはWindowsで、macOS artifactはApple Silicon Macで作成します。FFmpegの再配布条件は[第三者ライセンス](THIRD_PARTY_NOTICES.md)を確認してください。

## データと復旧

プロジェクトは`.satoimo`ディレクトリです。元動画はコピーせず、fingerprint付き参照として保持します。`project.json`はtemp→atomic renameで保存し、ひとつ前の`project.json.bak`を残します。イベントはJSON Lines、音声はPCM 16-bit mono WAVへ逐次保存します。

録音中に強制終了した場合、次回起動時に`.jsonl.part`と`.wav.part`を検出します。「復旧して確認」はJSONL末尾とWAV headerを修復します。「破棄」は削除せず`recovery/`へ退避します。

## トラブル対応

- `FFMPEG_MISSING`: FFmpeg/ffprobeを再配置し、配布buildならアプリを再インストールします。
- `FFMPEG_CAPABILITY`: `ffmpeg -filters`で`ass`、`ffmpeg -encoders`でH.264/AACを確認します。
- `MIC_PERMISSION`: OS設定でマイク権限を許可してから再起動します。
- `MIC_UNAVAILABLE`: 別のマイクを選び、他アプリの排他利用を終了します。
- `SOURCE_MISSING` / `SOURCE_MISMATCH`: 元動画を元の場所へ戻します。fingerprintが変わった動画を黙って使うことはありません。
- `DISK_LOW`: プロジェクトまたは出力先の空き容量を増やします。未完成出力は`.part.mp4`であり、完成ファイルを上書きしません。
- `EXPORT_FAILED`: 収録データは保持されます。確認画面から再試行できます。

既知の制約は[docs/known-limitations.md](docs/known-limitations.md)、要件との対応は[docs/requirements-traceability.md](docs/requirements-traceability.md)を参照してください。
