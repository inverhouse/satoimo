import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const output = resolve("test-fixtures/generated"); mkdirSync(output, { recursive: true });
const ffmpeg = process.env.SATOIMO_FFMPEG_PATH || "ffmpeg";
function run(args) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`fixture生成に失敗しました: ffmpeg ${args.join(" ")}`);
}
const video = ["-f","lavfi","-i","testsrc2=size=1920x1080:rate=60:duration=10","-f","lavfi","-i","sine=frequency=1000:sample_rate=48000:duration=10","-vf","drawtext=text='%{n}':fontsize=120:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2","-c:v","libx264","-pix_fmt","yuv420p","-preset","ultrafast","-c:a","aac","-shortest"];
run([...video, `${output}/cfr-h264-aac.mp4`]);
run(["-f","lavfi","-i","testsrc2=size=1280x720:rate=60:duration=10","-vf","select='not(mod(n,3))',setpts='N/(24*TB)'","-fps_mode","vfr","-c:v","libx264","-pix_fmt","yuv420p",`${output}/vfr.mp4`]);
run(["-f","lavfi","-i","testsrc2=size=1920x1080:rate=60:duration=10","-c:v","libx264","-pix_fmt","yuv420p","-an",`${output}/no-audio.mp4`]);
run(["-i",`${output}/cfr-h264-aac.mp4`,"-c","copy","-metadata:s:v:0","rotate=90",`${output}/rotation.mov`]);
run(["-f","lavfi","-i","sine=frequency=880:sample_rate=48000:duration=10","-af","adelay=250|250","-c:a","pcm_s16le",`${output}/commentary.wav`]);
console.log(`fixtureを生成しました: ${output}`);
