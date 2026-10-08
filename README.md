# satoimo（さといも）

アルティメットのプレイ動画に、後から実況や作戦の説明を加えるためのデスクトップアプリです。動画を見ながら音声、再生操作、描画、作戦ボードの操作を収録し、1本の実況動画として書き出せます。

## できること

- 動画の再生、停止、巻き戻し、速度変更に合わせて実況を録音
- 動画上への描画と、選手・ディスクを動かせる作戦ボードの収録
- 収録した順序で仕上がりをプレビューし、MP4（1080p・30fps、H.264/AAC）に書き出し
- アプリが予期せず終了した場合の収録データの復旧

## ダウンロード（GitHub Releases）

Windows（x64）版のインストーラーは [GitHub Releases](https://github.com/inverhouse/satoimo/releases) からダウンロードできます。macOS 版の DMG は今後公開予定です。変更点や利用時の注意事項は各 Release ページに掲載します。

## 使い方

1. アプリを起動し、「はじめる」から実況を付けたい動画を1本選びます。
2. マイクを確認して収録を開始します。動画の再生操作、描画、作戦ボードの操作も収録に反映されます。
3. 収録を終了し、完成動画のプレビューを確認します。
4. 保存先を選んで MP4 に書き出します。

録音にはマイクの接続と OS での使用許可が必要です。収録が予期せず中断した場合は、次回起動時に表示される案内から復旧できます。

## 開発者向け

開発には Node.js 20.19 以降の 20 系または 22.12 以降、Rust（stable）、各 OS の Tauri ビルド環境が必要です。依存パッケージはリポジトリのルートで `npm ci` を実行して導入します。FFmpeg は配布物に同梱する構成ですが、開発・ビルド前には以下の OS 別の準備が必要です。

### Windows（x64）

1. Visual Studio 2022 Build Tools（「C++ によるデスクトップ開発」）と WebView2 Runtime を用意します。
2. `powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1` で FFmpeg を取得します。
3. `npx tauri dev` で開発実行、`npx tauri build` でインストーラーを作成します。出力先は `src-tauri/target/release/bundle/nsis/` です。

### macOS（Apple Silicon / Intel）

1. Xcode Command Line Tools を用意します（`xcode-select --install`）。
2. `sh scripts/build-ffmpeg-macos.sh` で FFmpeg をビルドします。
3. `npx tauri dev` で開発実行、`npx tauri build` で DMG を作成します。出力先は `src-tauri/target/release/bundle/dmg/` です。

macOS の最小対応バージョンは 11.0 です。配布時にはアプリの署名と公証も確認してください。

### テスト

- `npm test`：収録イベントと完成時間軸の処理
- `cd src-tauri && cargo test`：音声の修復や動画の書き出しに関わる処理

### 主な構成

| 場所 | 内容 |
| --- | --- |
| `src/App.tsx`、`src/Record.tsx`、`src/Review.tsx`、`src/Export.tsx` | 画面と収録・確認・書き出しの操作 |
| `src/timeline.ts`、`src/render.ts` | 完成時間軸の計算と描画 |
| `src-tauri/src/` | 録音、セッションの保存・復旧、動画の書き出し |
| `scripts/` | OS 別の FFmpeg 準備スクリプト |

## ヘルプ・開発への参加

不具合の報告や質問、改善案は [GitHub Issues](https://github.com/inverhouse/satoimo/issues) にお寄せください。

## ライセンス

satoimo 本体は [MIT License](LICENSE) で公開しています。同梱する FFmpeg などのライセンスと入手先は [第三者ソフトウェアの表示](THIRD_PARTY_NOTICES.md) を参照してください。
