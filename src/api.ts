import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Ev } from "./timeline.ts";

export interface VideoInfo {
  path: string;
  name: string; // file name with extension
  playPath: string; // original or proxy
  fps: number;
  duration: number;
  hasAudio: boolean;
  colorTagged?: boolean;
}

/** A finished (confirmed) recording, ready for preview/export. */
export interface Done {
  dir: string;
  wav: string;
  duration: number;
  events: Ev[];
  video: VideoInfo;
  gains: Gains;
}

export interface Gains {
  voice: number;
  source: number;
}

export interface Found {
  dir: string;
  meta: string;
  events: string;
  audio: number;
  error: string | null;
}

export interface Meta {
  video: VideoInfo;
  gains: Gains;
}

export const src = (p: string) => convertFileSrc(p);
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const stem = (name: string) => name.replace(/\.[^.]+$/, "");
export const outputName = (v: VideoInfo) => `${stem(v.name)}_commentary.mp4`;

export const api = {
  probe: (path: string) => invoke<{ fps: number; duration: number; codec: string; hasAudio: boolean; colorTagged: boolean }>("probe_video", { path }),
  makeProxy: (v: VideoInfo) => invoke<string>("make_proxy", { path: v.path, duration: v.duration, colorTagged: !!v.colorTagged }),
  micList: () => invoke<{ id: string; name: string }[]>("mic_list"),
  micOpen: (id: string | null) => invoke<string>("mic_open", { id }),
  micLevel: () => invoke<[number, string | null]>("mic_level"),
  micClose: () => invoke("mic_close"),
  sessionCreate: (meta: Meta) => invoke<string>("session_create", { meta: JSON.stringify(meta) }),
  recStart: (dir: string) => invoke("rec_start", { dir }),
  recStop: () => invoke<number>("rec_stop"),
  append: (dir: string, text: string) => invoke("session_append", { dir, text }),
  rewriteEvents: (dir: string, text: string) => invoke("session_rewrite", { dir, text }),
  find: () => invoke<Found | null>("session_find"),
  audioLen: (dir: string) => invoke<number>("session_audio_len", { dir }),
  finalize: (dir: string) => invoke<[string, number]>("session_finalize", { dir }),
  discard: (keep: string | null = null, cache = false) => invoke("session_discard", { keep, cache }),
  exportWorkDir: () => invoke<string>("export_work_dir"),
  writeOverlay: (name: string, bytes: Uint8Array) => invoke<string>("write_overlay", bytes, { headers: { name } }),
  exportStart: (req: unknown) => invoke("export_start", { req }),
  exportCancel: () => invoke("export_cancel"),
};

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
