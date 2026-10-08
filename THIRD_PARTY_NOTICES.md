# Third-party notices / 同梱ソフトウェアの表記

さといも本体は MIT License です（`LICENSE`）。配布物には以下の第三者ソフトウェアが含まれ、それぞれのライセンスに従います。

## FFmpeg

さといもは FFmpeg を**別プロセスの実行ファイル**（`ffmpeg` / `ffmpeg.exe`）として同梱し、動画の読み込み・作業用動画の作成・MP4書き出しに使用しています。さといも本体は FFmpeg のライブラリにリンクしていません。

This software uses code of [FFmpeg](https://ffmpeg.org) licensed under the LGPL and its source can be downloaded as described below.

| OS | ビルド | ライセンス | 入手元 |
| --- | --- | --- | --- |
| Windows x64 | FFmpeg n9.0.2-22-g46d8f462ee（BtbN FFmpeg-Builds `autobuild-2026-10-07-13-07`, `ffmpeg-n9.0-latest-win64-lgpl-9.0.zip`）静的リンク | **LGPL v3**（`--enable-version3`。`--enable-gpl` / `--enable-nonfree` なし、x264・x265・fdk-aac を含まない） | `scripts/fetch-ffmpeg.ps1` |
| macOS | FFmpeg 9.0.2 公式ソースから `scripts/build-ffmpeg-macos.sh` でビルド | **LGPL v2.1 以降**（GPL・nonfree 無効） | `scripts/build-ffmpeg-macos.sh` |

- ライセンス全文: `licenses/FFmpeg-LGPL-3.0.txt`（LGPL v3）、`licenses/GPL-3.0.txt`（LGPL v3 が参照する GPL v3）
- ソースコード:
  - FFmpeg 本体: <https://ffmpeg.org/releases/>（9.0.2）および <https://github.com/FFmpeg/FFmpeg/commit/46d8f462ee>
  - Windows ビルドの構成スクリプトと同梱ライブラリの取得元: <https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-10-07-13-07>
  - **配布者の義務**: 公開配布する際は、上記の対応ソース（FFmpeg ソース tarball と BtbN のビルドスクリプト一式）を、配布物と同じ場所（例: GitHub Releases の添付ファイル）に置くか、少なくとも3年間有効な書面による提供の申し出を添えてください。第三者サイトへのリンクだけでは、その提供が継続される保証になりません。
- 利用者は同梱の `ffmpeg` を、互換性のある別ビルドに差し替えることができます（LGPL の再リンク要件。さといもは実行ファイルを呼び出すだけなので、同じ名前で置き換えれば動作します）。
- Windows ビルドには静的リンクされた複数のライブラリ（dav1d、libvpx、OpenH264、libopus など）が含まれ、それぞれ BSD・MIT・LGPL 等のライセンスを持ちます。各ライブラリの版とライセンスは上記 BtbN のスクリプトで確認できます。
- H.264 の書き出しには、OS が提供するエンコーダー（Windows: Media Foundation／NVENC・QSV・AMF、macOS: VideoToolbox）を優先して使用します。これらが使えない場合のみ、ソースからビルドされた OpenH264 を使います（Cisco が配布するバイナリではないため、同社の特許ライセンスの対象外です）。

## Noto Sans JP

画面表示とボード描画に Noto Sans JP（`@fontsource-variable/noto-sans-jp`）を使用しています。SIL Open Font License 1.1（`licenses/NotoSansJP-OFL-1.1.txt`）。

## その他の依存ライブラリ

Tauri、React、cpal、hound、png などの依存ライブラリは MIT または Apache-2.0 等のライセンスです。一覧は `npm ls` と `cargo tree`（またはソースの `package.json` / `src-tauri/Cargo.toml`）で確認できます。
