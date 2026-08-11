import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ExportProgress, InputDevice, Project, RecoveryCandidate, SessionEvent } from "./types";

const desktop = "__TAURI_INTERNALS__" in window;

function requireDesktop(): void {
  if (!desktop) throw new Error("この操作はデスクトップ版の「さといも」で利用できます。");
}

export const native = {
  isDesktop: desktop,
  async chooseSource(): Promise<string | null> {
    requireDesktop();
    return open({ multiple: false, directory: false, filters: [{ name: "動画", extensions: ["mp4", "mov", "m4v", "mkv", "avi", "webm"] }] });
  },
  async chooseProjectDirectory(): Promise<string | null> {
    requireDesktop();
    return open({ multiple: false, directory: true, title: "プロジェクトの保存先" });
  },
  async chooseProject(): Promise<string | null> {
    requireDesktop();
    return open({ multiple: false, directory: true, title: "さといもプロジェクトを開く" });
  },
  createProject: (sourcePath: string, parentPath: string, name: string) => invoke<Project>("create_project", { sourcePath, parentPath, name }),
  openProject: (projectPath: string) => invoke<Project>("open_project", { projectPath }),
  saveProject: (project: Project) => invoke<void>("save_project", { project }),
  recentProjects: () => invoke<Project[]>("recent_projects"),
  recoveryCandidates: () => invoke<RecoveryCandidate[]>("recovery_candidates"),
  recoverTake: (projectPath: string) => invoke<Project>("recover_take", { projectPath }),
  discardRecovery: (projectPath: string) => invoke<Project>("discard_recovery", { projectPath }),
  inputDevices: () => invoke<InputDevice[]>("input_devices"),
  startSession: (projectPath: string, deviceId: string, sourceUs: number, rate: number) => invoke<void>("start_session", { projectPath, deviceId, sourceUs, rate }),
  appendEvent: (eventType: string, payload: Record<string, unknown>, sourceDurationUs: number) => invoke<SessionEvent>("append_session_event", { eventType, payload, sourceDurationUs }),
  stopSession: (sourceUs: number, playing: boolean) => invoke<Project>("stop_session", { sourceUs, playing }),
  interruptSession: (reason: string, sourceUs: number) => invoke<Project>("interrupt_session", { reason, sourceUs }),
  loadEvents: (projectPath: string) => invoke<SessionEvent[]>("load_events", { projectPath }),
  abandonTake: (projectPath: string) => invoke<Project>("abandon_take", { projectPath }),
  createProxy: (projectPath: string) => invoke<Project>("create_proxy", { projectPath }),
  cancelProxy: () => invoke<void>("cancel_proxy"),
  onProxyProgress: (handler: (progress: ExportProgress) => void): Promise<UnlistenFn> => listen<ExportProgress>("proxy-progress", (event) => handler(event.payload)),
  async chooseExportPath(defaultName: string): Promise<string | null> {
    requireDesktop();
    return save({ defaultPath: defaultName, filters: [{ name: "MP4動画", extensions: ["mp4"] }] });
  },
  exportVideo: (projectPath: string, outputPath: string) => invoke<void>("export_video", { projectPath, outputPath }),
  cancelExport: () => invoke<void>("cancel_export"),
  onExportProgress: (handler: (progress: ExportProgress) => void): Promise<UnlistenFn> => listen<ExportProgress>("export-progress", (event) => handler(event.payload)),
  onMicLevel: (handler: (level: { rms: number; peak: number }) => void): Promise<UnlistenFn> => listen("mic-level", (event) => handler(event.payload as { rms: number; peak: number })),
  onRecordingError: (handler: (message: string) => void): Promise<UnlistenFn> => listen<string>("recording-error", (event) => handler(event.payload)),
  reveal: (path: string) => revealItemInDir(path),
  openPath: (path: string) => openPath(path),
};
