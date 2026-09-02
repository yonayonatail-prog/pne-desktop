import type { AudioPart, DisplayPart, Effect, NameSlot, RuntimeSnapshot, Scenario, ScenarioNode } from "@pne/player-core";

export type { AudioPart, DisplayPart, Effect, ScenarioNode };

export type WorkInstallState = "NOT_INSTALLED" | "DOWNLOADING" | "VERIFYING" | "READY" | "UPDATE_AVAILABLE" | "CORRUPT" | "INCOMPATIBLE";

export interface WorkCapabilities {
  web_playable: boolean;
  desktop_playable: boolean;
  name_call_supported: boolean;
  mobile_transfer_supported: boolean;
}

export interface LocalWork {
  workId: string;
  version: string;
  title: string;
  author: string;
  description: string;
  cover: string;
  durationLabel: string;
  durationMs?: number;
  sizeLabel: string;
  state: WorkInstallState;
  capabilities: WorkCapabilities;
  scenario: Scenario;
  nameSlots: NameSlot[];
  nameVoice?: LocalNameVoiceConfig;
}

export interface LocalVoiceProfile {
  reference: string;
  reference_version?: string;
  enabled?: boolean;
}

export interface LocalNameVoiceConfig {
  preview_slot_id?: string;
  voice_profiles: Record<string, LocalVoiceProfile>;
}

export interface NameProfile {
  displayName: string;
  reading: string;
  form: "bare" | "san" | "kun" | "chan" | "senpai";
  saveCandidate: boolean;
}

export interface StoredSession {
  workId: string;
  workVersion: string;
  profile: NameProfile | null;
  snapshot: RuntimeSnapshot;
  updatedAt: string;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  tauri: boolean;
  platform: string;
  webview: string;
  webGpu: "available" | "unavailable";
  microphone: "unchecked" | "available" | "denied";
  storageBytes: number;
  modelState: "NOT_INSTALLED" | "PARTIAL" | "READY";
  releaseConfiguration: "DEVELOPMENT" | "PRODUCTION";
}
