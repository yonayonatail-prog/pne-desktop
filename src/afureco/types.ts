export type LineStatus = "NOT_RECORDED" | "IN_PROGRESS" | "SUBMITTED" | "REVISION_REQUESTED" | "APPROVED";
export type TakeSyncStatus = "LOCAL_ONLY" | "UPLOADING" | "SYNCED" | "RETRY_REQUIRED";
export type TakeReviewStatus = "DRAFT" | "SUBMITTED" | "REVISION_REQUESTED" | "APPROVED";

export interface ScriptLine {
  lineId: string;
  nodeId: string;
  sceneId: string;
  sceneName: string;
  characterId: string;
  speakerName: string;
  text: string;
  reading?: string;
  direction?: string;
  expectedDurationMs?: number;
  status: LineStatus;
}

export interface Take {
  takeId: string;
  projectId: string;
  lineId: string;
  actorId: string;
  fileId: string;
  recordedAt: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  syncStatus: TakeSyncStatus;
  reviewStatus: TakeReviewStatus;
  memo?: string;
  isSelected: boolean;
}

export interface AfurecoProject {
  projectId: string;
  projectName: string;
  workTitle: string;
  scriptVersion: string;
  assignedCharacter: string;
  actorName: string;
  state: "DRAFT" | "CASTING" | "RECORDING" | "REVIEW" | "READY" | "EXPORTED";
  sourceFileName?: string;
  lines: ScriptLine[];
}
