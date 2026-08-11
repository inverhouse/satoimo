# Third-Party Notices

さといも本体はリポジトリの`LICENSE`に従います。配布担当者は、実際に同梱するbinaryとnpm/Cargo lockfileに対応するnoticeを配布物へ含めてください。

## FFmpeg / ffprobe

FFmpegはFFmpeg projectの著作物です。ライセンスはbuild構成によりLGPL 2.1-or-laterまたはGPL 2.0-or-laterです。`libx264`を有効にした一般的なbuildはGPLになります。配布するbinaryの`ffmpeg -buildconf`を確認し、対応するライセンス文、source入手方法、必要なofferを添付してください。

- Project: https://ffmpeg.org/
- License: https://ffmpeg.org/legal.html

`libass`（ISC）、x264（GPL-2.0-or-later）、VideoToolboxなど、FFmpegがリンクする各ライブラリの条件も同梱buildに従います。さといもはFFmpegを別processのsidecarとして引数配列で起動します。

## Tauri / Rust crates

Tauri 2および主要なRust crate（Serde、CPAL、hound、SHA-2、chrono、uuidほか）はMIT、Apache-2.0または互換するpermissive licenseで提供されます。正確なversionは`src-tauri/Cargo.lock`を正本とし、配布時に`cargo about`等で全依存のnoticeを生成してください。

## React / TypeScript ecosystem

React、React DOM、Vite、TypeScript、Vitest、Testing LibraryおよびTauri JavaScript packagesは主にMIT licenseです。正確なversionは`package-lock.json`を正本とし、配布時にlicense reportを生成してください。

この文書は法的助言ではありません。FFmpeg buildの再配布条件は配布者が最終確認してください。
