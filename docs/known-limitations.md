# 既知の制約

- 初版対象はWindows 10/11 x64とApple Silicon macOS 13以降だけです。Linux、Intel Mac、Windows ARMはbuild対象外です。
- 収録の部分修正、トリミング、複数take選択はありません。問題がある場合は収録全体をやり直します。
- 入力は30分以内のローカル動画1本です。YouTube、cloud、複数camera、BGM、字幕編集はありません。
- ペンは一時停止中のフリーハンド線だけです。描いた線は再生開始時に自動的に消えます。redo、消しゴム、図形、laser pointerはありません。
- 完成前プレビューはHTML videoをイベント駆動でseekするため、端末のdecoderによっては高速な巻き戻し直後に一瞬遅延します。書き出し結果はFFmpegのframe timelineを使用します。
- マイク信号処理はmono downmixと必要時の48kHz resampleだけです。ノイズ除去、compressor、loudness自動補正はありません。
- FFmpeg/ffprobe binary自体はリポジトリへ含めません。配布時に対象OS用buildを`prepare:sidecars`で組み込み、ライセンス条件を満たす必要があります。
- 2026-08-10時点の開発確認はApple Silicon macOS上の自動テストとbuild検査です。Windows 10/11実機、8GB・30分素材、署名installer、Gatekeeper/SmartScreen、実マイク切断・OS sleepの手動受入試験は対象実機で別途実行が必要です。
