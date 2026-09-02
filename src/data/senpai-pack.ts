import type { ReactionInput } from "@pne/player-core";
import type { AudioPart, DisplayPart, Effect, LocalWork, ScenarioNode } from "../types";
import sourcePack from "../../../台本/audio_projects/ネチネチ系後輩が詰めてくる/senpai_script_pack_v02_forced_interpretation.json";

interface SourceAudioPart { src?: string; name_call?: string }
interface SourceLine {
  line_id: string;
  speaker?: string;
  text?: string;
  performance?: Record<string, unknown>;
}
interface SourceNode {
  node_id: string;
  type: "normal" | "reaction_prompt" | "reaction_branch" | "join" | "effect" | "end";
  lines?: SourceLine[];
  next?: string[] | string | null;
  mapped_action?: string;
  memory_updates?: Record<string, string>;
  relationship_shift?: { to?: string };
  performance?: { pause_before_ms?: number; pause_after_ms?: number };
  audio?: { src?: string; sequence?: SourceAudioPart[] };
  reaction_window?: { window_ms: number; branches: Record<"VOICE" | "SILENT" | "UNKNOWN", string> };
}

const pack = sourcePack as unknown as { meta: { title: string; version: string; character: string }; entry_node: string; nodes: SourceNode[] };
const sourceNodes = new Map(pack.nodes.map((node) => [node.node_id, node]));
const nameSlotId = "name.main";
const allInputs: ReactionInput[] = ["VOICE", "VOICE_YES", "VOICE_NO", "VOICE_OTHER", "CLICK_SINGLE", "CLICK_DOUBLE", "SILENT", "NEXT"];

function displaySequence(text = ""): DisplayPart[] {
  const pieces = text.split("{{name}}");
  return pieces.flatMap<DisplayPart>((piece, index) => {
    const result: DisplayPart[] = [];
    if (piece) result.push({ text: piece });
    if (index < pieces.length - 1) result.push({ name_slot_id: nameSlotId });
    return result;
  });
}

function audioUrl(source: string): string {
  return `/senpai-audio/${source.replaceAll("\\", "/").split("/").at(-1)}`;
}

function primaryLine(node: SourceNode): SourceLine {
  return node.lines?.[0] || { line_id: `${node.node_id}_001` };
}

function nodeSpeaker(node: SourceNode): string | undefined {
  return primaryLine(node).speaker;
}

function nodeText(node: SourceNode): string {
  return primaryLine(node).text || "";
}

function nodePerformance(node: SourceNode): SourceNode["performance"] {
  const performance = primaryLine(node).performance;
  return (performance || node.performance) as SourceNode["performance"];
}

function nextTarget(node: SourceNode): string | null {
  if (Array.isArray(node.next)) return node.next[0] || null;
  return typeof node.next === "string" ? node.next : null;
}

function audioSequence(node: SourceNode): AudioPart[] {
  const sequence: AudioPart[] = [];
  const performance = nodePerformance(node);
  if (performance?.pause_before_ms) sequence.push({ gap_ms: performance.pause_before_ms });
  if (node.audio?.src) sequence.push({ clip_id: audioUrl(node.audio.src) });
  for (const part of node.audio?.sequence ?? []) {
    if (part.src) sequence.push({ clip_id: audioUrl(part.src) });
    else if (part.name_call) sequence.push({ name_slot_id: nameSlotId });
  }
  if (performance?.pause_after_ms) sequence.push({ gap_ms: performance.pause_after_ms });
  return sequence.length ? sequence : [{ gap_ms: 350 }];
}

function nodeEffects(node: SourceNode): Effect[] | undefined {
  const effects: Effect[] = [];
  if (node.type === "effect" && node.node_id === "START_BLACKOUT") effects.push({ variable: "visual.blackout", operation: "set", value: true });
  if (node.relationship_shift?.to) effects.push({ variable: "relationship", operation: "set", value: node.relationship_shift.to });
  for (const [variable, value] of Object.entries(node.memory_updates ?? {})) {
    if (value === "+1") effects.push({ variable, operation: "increment", value: 1 });
    else effects.push({ variable, operation: "set", value });
  }
  return effects.length ? effects : undefined;
}

function contextAction(targetId: string, fallback: string): string {
  return sourceNodes.get(targetId)?.mapped_action ?? fallback;
}

function convertNode(node: SourceNode, index: number): ScenarioNode[] {
  const timeline_ms = index * 4_000;
  if (node.type === "end") {
    return [
      { id: node.node_id, type: "line", timeline_ms, speaker: nodeSpeaker(node), display_sequence: displaySequence(nodeText(node)), audio: { sequence: audioSequence(node) }, advance: "auto", next: "END" },
      { id: "END", type: "end", timeline_ms: timeline_ms + 3_000, speaker: nodeSpeaker(node), display_sequence: displaySequence(nodeText(node)) }
    ];
  }
  if (node.type === "reaction_prompt" && node.reaction_window) {
    const targets = node.reaction_window.branches;
    const voiceAction = contextAction(targets.VOICE, "RESPOND");
    const silentAction = contextAction(targets.SILENT, "NO_RESPONSE");
    const unknownAction = contextAction(targets.UNKNOWN, "NO_CLEAR_RESPONSE");
    return [{
      id: node.node_id,
      type: "reaction_prompt",
      timeline_ms,
      speaker: nodeSpeaker(node),
      display_sequence: displaySequence(nodeText(node)),
      audio: { sequence: audioSequence(node) },
      reaction_window: {
        window_ms: node.reaction_window.window_ms,
        accepted_raw_inputs: allInputs,
        timeout_input: "SILENT",
        context_mapping: {
          VOICE: voiceAction,
          VOICE_YES: voiceAction,
          VOICE_NO: voiceAction,
          VOICE_OTHER: voiceAction,
          CLICK_SINGLE: voiceAction,
          CLICK_DOUBLE: voiceAction,
          NEXT: voiceAction,
          SILENT: silentAction,
          UNKNOWN: unknownAction
        },
        detection: { detailed_inputs: false, minimum_confidence: 0.7 },
        branches: {
          [voiceAction]: targets.VOICE,
          [silentAction]: targets.SILENT,
          [unknownAction]: targets.UNKNOWN
        }
      }
    }];
  }
  const target = nextTarget(node);
  if (!target) throw new Error(`${node.node_id}: migrated line requires next`);
  return [{
    id: node.node_id,
    type: "line",
    timeline_ms,
    speaker: nodeSpeaker(node),
    display_sequence: displaySequence(nodeText(node)),
    audio: { sequence: audioSequence(node) },
    effects: nodeEffects(node),
    advance: "auto",
    next: target
  }];
}

const scenarioNodes = pack.nodes.flatMap(convertNode);

export const SENPAI_WORK: LocalWork = {
  workId: "senpai_forced_interpretation",
  version: `${pack.meta.version}.0-dev`,
  title: pack.meta.title,
  author: "P.N.E. Studio",
  description: "軽薄で甘い後輩・蒼汰との距離が、返事と沈黙によって少しずつ変わるReactionLoopサンプルです。",
  cover: "/chara_03.PNG",
  durationLabel: "約3分",
  durationMs: 188_000,
  sizeLabel: "音声付き開発fixture・約6MB",
  state: "READY",
  capabilities: { web_playable: true, desktop_playable: true, name_call_supported: true, mobile_transfer_supported: true },
  nameSlots: [{ slot_id: nameSlotId, voice_id: "hiiro", form: "profile", fallback_clip_id: "voice.name.fallback", fallback_text: "そこの", post_gap_ms: 40, crossfade_ms: 5 }],
  nameVoice: {
    preview_slot_id: nameSlotId,
    voice_profiles: { hiiro: { reference: "/voice-reference/hiiro.ogg", reference_version: "hiiro-n1-02-ogg-v1", enabled: true } }
  },
  scenario: { schema_version: "1.0", entry_node: pack.entry_node, nodes: scenarioNodes }
};
