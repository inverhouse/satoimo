import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const fixture = "test-fixtures/generated/cfr-h264-aac.mp4";
if (!existsSync(fixture)) throw new Error("先に npm run fixtures を実行してください。");
const ffprobe = process.env.SATOIMO_FFPROBE_PATH || "ffprobe";
const result = spawnSync(ffprobe, ["-v","error","-select_streams","v:0","-show_entries","stream=width,height,r_frame_rate,pix_fmt","-show_entries","format=duration","-of","json",fixture], { encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
const data = JSON.parse(result.stdout); const stream = data.streams[0];
if (stream.width !== 1920 || stream.height !== 1080 || stream.r_frame_rate !== "60/1" || stream.pix_fmt !== "yuv420p") throw new Error(`fixture仕様が不正です: ${result.stdout}`);
console.log("fixture smoke test: OK");
