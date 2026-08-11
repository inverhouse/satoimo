import { copyFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const triple = process.platform === "darwin" && process.arch === "arm64"
  ? "aarch64-apple-darwin"
  : process.platform === "win32" && process.arch === "x64"
    ? "x86_64-pc-windows-msvc"
    : null;
if (!triple) throw new Error(`未対応のビルド環境です: ${process.platform}/${process.arch}`);

const suffix = process.platform === "win32" ? ".exe" : "";
const find = (name, variable) => {
  const explicit = process.env[variable];
  if (explicit && existsSync(explicit)) return explicit;
  const finder = process.platform === "win32" ? "where" : "which";
  try { return execFileSync(finder, [`${name}${suffix}`], { encoding: "utf8" }).trim().split(/\r?\n/)[0]; }
  catch { throw new Error(`${name} がありません。${variable} に実行ファイルのパスを設定してください。`); }
};

const directory = resolve("src-tauri/binaries"); mkdirSync(directory, { recursive: true });
for (const [name, variable] of [["ffmpeg", "SATOIMO_FFMPEG_PATH"], ["ffprobe", "SATOIMO_FFPROBE_PATH"]]) {
  const destination = join(directory, `${name}-${triple}${suffix}`);
  if (existsSync(destination)) unlinkSync(destination);
  copyFileSync(find(name, variable), destination);
}
console.log(`FFmpeg sidecarを ${triple} 向けに準備しました。`);
