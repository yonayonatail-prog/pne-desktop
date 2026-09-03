import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { platform } from "../lib/platform";
import { PageHeader } from "./shared";
import { SAMPLE_AUTHORING_PACK } from "../authoring/sample-pack";
import { VoiceGenerationPanel } from "./VoiceGenerationPanel";
import { DEFAULT_VOICE_PRESETS } from "../authoring/voice-generation/voice-preset-catalog";
import type { AuthoringCharacter, AuthoringNode, AuthoringPack, AuthoringTab, CharacterTimeline, TimelineBeat, ValidationIssue, VoiceGenerationManifest } from "../authoring/types";
import type { VoiceCandidateAudio, VoiceRoundWithAudio } from "../authoring/voice-generation/types";

const INPUTS = ["VOICE", "SILENT", "UNKNOWN"] as const;
type RuntimeSnapshot = { currentId: string; runtime: Record<string, unknown>; path: string[] };
type SaveFileHandle = { createWritable: () => Promise<{ write: (contents: string) => Promise<void>; close: () => Promise<void> }> };
type WindowWithSavePicker = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<SaveFileHandle>;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const nodeText = (node: AuthoringNode) => node.text || "（本文なし）";
const nodeTypeLabel: Record<string, string> = { start: "開始", normal: "通常", reaction: "反応受付", reaction_prompt: "反応受付", branch: "分岐", reaction_branch: "反応差分", join: "合流", end: "終端" };

const isRecord = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const asText = (value: unknown, fallback = "") => typeof value === "string" ? value : value == null ? fallback : String(value);

function suggestedScriptFileName(title: string): string {
  const safeTitle = title.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/[. ]+$/g, "").trim();
  return `${safeTitle || "新しい台本"}.json`;
}

function normalizeScriptFileName(value: string): string {
  const trimmed = value.trim();
  const base = trimmed.replace(/\.json$/i, "").trim();
  if (!base) throw new Error("ファイル名を入力してください");
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(base) || /[. ]$/.test(base)) {
    throw new Error("ファイル名に使用できない文字が含まれています");
  }
  if (base.length > 120) throw new Error("ファイル名は120文字以内で入力してください");
  return `${base}.json`;
}

function createEmptyAuthoringPack(title: string): AuthoringPack {
  return {
    format: "pne_statekit_pack",
    schema_version: "1.0.0",
    meta: { title, version: "draft" },
    entry_node: "START",
    characters: [],
    character_timelines: [],
    experience_routes: [{ route_id: "route_main", kind: "main", label: "Main", entry_unit_id: "" }],
    experience_timeline: [],
    experience_links: [],
    mislead_foreshadow_registry: [],
    state_schema: { variables: [], flags: [] },
    pne_rules: { input_types: [...INPUTS], unknown_behavior: "progress", reaction_loop_max_turns: 1 },
    runtime_state: { memory: {} },
    nodes: [{ id: "START", type: "start", speaker: "", text: "", next: null }]
  };
}

function parseJsonText(text: string, filename: string): unknown {
  const source = text.replace(/^\uFEFF/, "");
  try { return JSON.parse(source) as unknown; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = Number(message.match(/position\s+(\d+)/i)?.[1]);
    if (Number.isInteger(position)) {
      const before = source.slice(0, position);
      const line = before.split("\n").length;
      const column = position - before.lastIndexOf("\n");
      throw new Error(`${filename}: JSON構文エラー（${line}行 ${column}列）\n${message}`);
    }
    const lineColumn = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lineColumn) throw new Error(`${filename}: JSON構文エラー（${lineColumn[1]}行 ${lineColumn[2]}列）\n${message}`);
    throw new Error(`${filename}: JSONを解析できません\n${message}`);
  }
}

function normalizeImportedJson(value: unknown, filename = "JSON"): AuthoringPack {
  const source = isRecord(value) ? value : {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const rawCharacters = Array.isArray(source.characters)
    ? source.characters
    : isRecord(source.character_definitions)
      ? Object.entries(source.character_definitions).map(([character_id, character]) => ({ character_id, ...(isRecord(character) ? character : { name: character }) }))
      : isRecord(source.character_definition)
        ? (Object.prototype.hasOwnProperty.call(source.character_definition, "id") || Object.prototype.hasOwnProperty.call(source.character_definition, "character_id") || Object.prototype.hasOwnProperty.call(source.character_definition, "name") || Object.prototype.hasOwnProperty.call(source.character_definition, "full_name")
          ? [source.character_definition]
          : Object.entries(source.character_definition).map(([character_id, character]) => ({ character_id, ...(isRecord(character) ? character : { name: character }) })))
        : [];
  const nodes: AuthoringNode[] = rawNodes.map((rawNode, index) => {
    const node = isRecord(rawNode) ? rawNode : {};
    const id = asText(node.id || node.node_id, `NODE_${String(index + 1).padStart(3, "0")}`);
    const rawLines = Array.isArray(node.lines) ? node.lines.filter(isRecord) : [];
    const lineSpeaker = rawLines.map((line) => asText(line.speaker)).find(Boolean);
    const lineText = rawLines.map((line) => asText(line.text)).filter(Boolean).join("\n");
    const linePerformance = rawLines[0] && isRecord(rawLines[0].performance) ? rawLines[0].performance : undefined;
    const nextIds = Array.isArray(node.next_ids)
      ? node.next_ids.filter((target): target is string => typeof target === "string")
      : Array.isArray(node.next)
        ? node.next.filter((target): target is string => typeof target === "string")
        : undefined;
    return {
      ...node,
      id,
      node_id: typeof node.node_id === "string" ? node.node_id : undefined,
      type: (asText(node.type, "normal") || "normal") as AuthoringNode["type"],
      source_unit_id: asText(node.source_unit_id) || undefined,
      chapter: asText(node.chapter) || undefined,
      state: asText(node.state) || undefined,
      speaker: asText(node.speaker) || lineSpeaker || "",
      text: asText(node.text ?? node.dialogue ?? node.narrative_description) || lineText,
      next: typeof node.next === "string" ? node.next : nextIds?.[0] || null,
      next_ids: nextIds,
      performance: isRecord(node.performance) ? node.performance : linePerformance,
      reaction_window: isRecord(node.reaction_window) ? {
        ...node.reaction_window,
        window_ms: typeof node.reaction_window.window_ms === "number" ? node.reaction_window.window_ms : 0,
        accepted_raw_inputs: Array.isArray(node.reaction_window.accepted_raw_inputs) ? node.reaction_window.accepted_raw_inputs.filter((input): input is string => typeof input === "string") : [],
        branches: isRecord(node.reaction_window.branches) ? Object.fromEntries(Object.entries(node.reaction_window.branches).map(([input, target]) => [input, asText(target)])) : {}
      } : undefined,
      state_updates: isRecord(node.state_updates) ? node.state_updates : undefined,
      memory_updates: isRecord(node.memory_updates) ? node.memory_updates : undefined,
    };
  });
  if (!nodes.length) nodes.push({ id: "JSON_ROOT", type: "normal", speaker: "JSON", text: JSON.stringify(value, null, 2), next: null });

  const characterMap = new Map<string, AuthoringCharacter>();
  for (const rawCharacter of rawCharacters) {
    const character = isRecord(rawCharacter) ? rawCharacter : {};
    const characterId = asText(character.character_id || character.id || character.name);
    if (!characterId) continue;
    characterMap.set(characterId, {
      character_id: characterId,
      name: asText(character.name || character.full_name, characterId),
      color: asText(character.color, "purple"),
      voice_preset_id: asText(character.voice_preset_id) || undefined,
      first_person: asText(character.first_person || character.firstPerson) || undefined,
      profile: isRecord(character.profile) ? character.profile : {}
    });
  }
  for (const node of nodes) {
    if (node.speaker && node.speaker !== "NARRATOR" && !characterMap.has(node.speaker)) characterMap.set(node.speaker, { character_id: node.speaker, name: node.speaker, color: "purple", profile: {} });
  }
  if (!characterMap.size) characterMap.set("JSON", { character_id: "JSON", name: "JSON", color: "purple", profile: {} });

  const runtimeState = isRecord(source.runtime_state) ? source.runtime_state : {};
  const stateSchema = isRecord(source.state_schema) ? source.state_schema : {};
  const rawVariables = Array.isArray(stateSchema.variables) ? stateSchema.variables : Object.entries(runtimeState).filter(([, initial]) => typeof initial === "number").map(([key, initial]) => ({ key, type: "number", initial, min: 0, max: 999 }));
  const variables = rawVariables.filter(isRecord).map((variable, index) => ({
    key: asText(variable.key, `state_${index + 1}`),
    type: variable.type === "integer" ? "integer" as const : "number" as const,
    initial: typeof variable.initial === "number" ? variable.initial : 0,
    min: typeof variable.min === "number" ? variable.min : 0,
    max: typeof variable.max === "number" ? variable.max : 999
  }));
  const rawFlags = Array.isArray(stateSchema.flags) ? stateSchema.flags : Object.entries(runtimeState).filter(([, initial]) => typeof initial === "boolean").map(([key, initial]) => ({ key, type: "boolean", initial }));
  const flags = rawFlags.filter(isRecord).map((flag, index) => ({ key: asText(flag.key, `flag_${index + 1}`), type: "boolean" as const, initial: flag.initial === true }));
  const chapters = Array.isArray(source.chapters) ? source.chapters : [];
  const rawTimeline = Array.isArray(source.experience_timeline) ? source.experience_timeline : chapters.map((chapter, index) => ({ unit_id: asText(chapter?.id, `chapter_${index + 1}`), route_id: "route_main", order: index + 1, unit: asText(chapter?.title, "Chapter"), viewer_state_start: "", viewer_state_end: "", inversion: "" }));
  const timeline = rawTimeline.filter(isRecord).map((unit, index) => ({
    ...unit,
    unit_id: asText(unit.unit_id, `unit_${index + 1}`), route_id: asText(unit.route_id, "route_main"), order: typeof unit.order === "number" ? unit.order : index + 1,
    unit: asText(unit.unit, `Unit ${index + 1}`), viewer_state_start: asText(unit.viewer_state_start), viewer_state_end: asText(unit.viewer_state_end), inversion: asText(unit.inversion),
    emotional_peak: asText(unit.emotional_peak), complicity_trigger: asText(unit.complicity_trigger)
  }));
  const characterTimelines = (Array.isArray(source.character_timelines) ? source.character_timelines : []).filter(isRecord).map((timeline, index) => ({
    ...timeline,
    character_id: asText(timeline.character_id, `character_${index + 1}`),
    beats: (Array.isArray(timeline.beats) ? timeline.beats : []).filter(isRecord).map((beat) => ({ ...beat, phase: asText(beat.phase, "mid"), label: asText(beat.label, "Beat"), key_event: asText(beat.key_event), inner_state: asText(beat.inner_state) }))
  }));
  const experienceLinks = (Array.isArray(source.experience_links) ? source.experience_links : []).filter(isRecord).map((link, index) => ({
    ...link, link_id: asText(link.link_id, `link_${index + 1}`), from_unit_id: asText(link.from_unit_id), to_unit_id: asText(link.to_unit_id), type: asText(link.type, "main") as AuthoringPack["experience_links"][number]["type"]
  }));
  const title = isRecord(source.meta) ? asText(source.meta.title, filename.replace(/\.json$/i, "")) : filename.replace(/\.json$/i, "") || "JSONドキュメント";
  const voiceProfiles = Array.isArray(source.voice_profiles) ? source.voice_profiles.filter(isRecord).map((profile, index) => ({
    voice_id: asText(profile.voice_id, `voice_${index + 1}`),
    voice_preset_id: asText(profile.voice_preset_id) || undefined,
    reference_audio: asText(profile.reference_audio) || undefined,
    reference_version: asText(profile.reference_version) || undefined,
    enabled: profile.enabled !== false
  })) : undefined;

  return {
    format: source.format === "pne_statekit_pack" ? "pne_statekit_pack" : "pne_statekit_pack",
    schema_version: asText(source.schema_version, "1.0.0"),
    meta: { ...(isRecord(source.meta) ? source.meta : {}), title, version: isRecord(source.meta) ? asText(source.meta.version, "imported") : "imported" },
    entry_node: asText(source.entry_node || source.start_node_id, nodes[0].id),
    characters: [...characterMap.values()],
    character_timelines: characterTimelines,
    experience_routes: Array.isArray(source.experience_routes) ? source.experience_routes : [{ route_id: "route_main", kind: "main", label: "Imported", entry_unit_id: "" }],
    experience_timeline: timeline,
    experience_links: experienceLinks,
    mislead_foreshadow_registry: Array.isArray(source.mislead_foreshadow_registry) ? source.mislead_foreshadow_registry : [],
    state_schema: { variables, flags },
    pne_rules: isRecord(source.pne_rules) ? source.pne_rules as AuthoringPack["pne_rules"] : { input_types: [...INPUTS], unknown_behavior: "progress", reaction_loop_max_turns: 1 },
    runtime_state: { ...runtimeState, memory: isRecord(runtimeState.memory) ? runtimeState.memory : {} },
    nodes,
    voice_profiles: voiceProfiles,
    voice_generation: isRecord(source.voice_generation) ? source.voice_generation as AuthoringPack["voice_generation"] : undefined
  };
}

function outgoing(node: AuthoringNode): Array<{ label: string; target: string }> {
  if (node.reaction_window?.branches) return Object.entries(node.reaction_window.branches).map(([input, target]) => ({ label: input, target }));
  const targets = node.next_ids?.length ? node.next_ids : node.next ? [node.next] : [];
  return targets.map((target, index) => ({ label: targets.length > 1 ? `出口${index + 1}` : "次へ", target }));
}

type FlowEdge = { from: string; to: string; labels: string[] };
type FlowPosition = { x: number; y: number };
type FlowLayout = { positions: Map<string, FlowPosition>; edges: FlowEdge[]; width: number; height: number };

const FLOW_NODE_WIDTH = 250;
const FLOW_NODE_HEIGHT = 142;
const FLOW_HORIZONTAL_GAP = 42;
const FLOW_VERTICAL_GAP = 74;

function makeFlowLayout(nodes: AuthoringNode[], entryNode: string): FlowLayout {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeMap = new Map<string, FlowEdge>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    const targets = adjacency.get(node.id) || [];
    for (const edge of outgoing(node)) {
      if (!edge.target || !nodeIds.has(edge.target)) continue;
      if (!targets.includes(edge.target)) targets.push(edge.target);
      const key = `${node.id}\u0000${edge.target}`;
      const current = edgeMap.get(key) || { from: node.id, to: edge.target, labels: [] };
      if (edge.label !== "次へ" && !current.labels.includes(edge.label)) current.labels.push(edge.label);
      edgeMap.set(key, current);
    }
    adjacency.set(node.id, targets);
  }

  const rank = new Map<string, number>();
  const order = new Map<string, number>();
  let orderIndex = 0;
  const start = nodeIds.has(entryNode) ? entryNode : nodes[0]?.id;
  const stack: Array<{ id: string; depth: number; path: Set<string> }> = start ? [{ id: start, depth: 0, path: new Set() }] : [];

  while (stack.length) {
    const current = stack.pop()!;
    rank.set(current.id, Math.max(rank.get(current.id) ?? 0, current.depth));
    if (!order.has(current.id)) order.set(current.id, orderIndex++);
    if (current.path.has(current.id)) continue;
    const path = new Set(current.path);
    path.add(current.id);
    const children = adjacency.get(current.id) || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ id: children[index], depth: current.depth + 1, path });
    }
  }

  const reachableRanks = [...rank.values()];
  const orphanRank = reachableRanks.length ? Math.max(...reachableRanks) + 1 : 0;
  for (const node of nodes) {
    if (!rank.has(node.id)) rank.set(node.id, orphanRank);
    if (!order.has(node.id)) order.set(node.id, orderIndex++);
  }

  const rows = new Map<number, string[]>();
  for (const node of nodes) {
    const row = rows.get(rank.get(node.id)!) || [];
    row.push(node.id);
    rows.set(rank.get(node.id)!, row);
  }
  for (const row of rows.values()) row.sort((left, right) => order.get(left)! - order.get(right)!);

  const sortedRows = [...rows.entries()].sort(([left], [right]) => left - right).map(([, row]) => row);
  const maxColumns = Math.max(1, ...sortedRows.map((row) => row.length));
  const width = Math.max(760, maxColumns * FLOW_NODE_WIDTH + (maxColumns - 1) * FLOW_HORIZONTAL_GAP + 48);
  const height = Math.max(270, sortedRows.length * FLOW_NODE_HEIGHT + Math.max(0, sortedRows.length - 1) * FLOW_VERTICAL_GAP + 48);
  const positions = new Map<string, FlowPosition>();

  sortedRows.forEach((row, rowIndex) => {
    const rowWidth = row.length * FLOW_NODE_WIDTH + Math.max(0, row.length - 1) * FLOW_HORIZONTAL_GAP;
    const startX = (width - rowWidth) / 2;
    row.forEach((id, columnIndex) => positions.set(id, {
      x: startX + columnIndex * (FLOW_NODE_WIDTH + FLOW_HORIZONTAL_GAP),
      y: 24 + rowIndex * (FLOW_NODE_HEIGHT + FLOW_VERTICAL_GAP)
    }));
  });

  return { positions, edges: [...edgeMap.values()], width, height };
}

function FlowGraph({ nodes, entryNode, currentId, onSelect }: { nodes: AuthoringNode[]; entryNode: string; currentId: string; onSelect: (id: string) => void }) {
  const layout = useMemo(() => makeFlowLayout(nodes, entryNode), [nodes, entryNode]);

  return <div className="authoring-flow-graph-shell">
    <div className="authoring-flow-legend">
      <span><i className="flow-legend-dot entry" /> ENTRY</span>
      <span><i className="flow-legend-dot reaction" /> 反応受付</span>
      <span><i className="flow-legend-line" /> 線のラベル = 入力分岐</span>
      <span className="authoring-flow-legend-note">ノードをクリックすると台本編集へ移動</span>
    </div>
    <div className="authoring-flow-graph-scroll">
      <svg className="authoring-flow-graph" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="シナリオRuntime構造フロー">
        <defs>
          <marker id="authoring-flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 z" className="flow-arrow-head" />
          </marker>
          <marker id="authoring-flow-arrow-branch" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L8,4 L0,8 z" className="flow-arrow-head branch" />
          </marker>
        </defs>
        <g className="flow-edges" aria-hidden="true">
          {layout.edges.map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const startX = from.x + FLOW_NODE_WIDTH / 2;
            const startY = from.y + FLOW_NODE_HEIGHT;
            const endX = to.x + FLOW_NODE_WIDTH / 2;
            const endY = to.y;
            const midY = startY + Math.max(22, (endY - startY) / 2);
            const path = endY >= startY
              ? `M ${startX} ${startY} V ${midY} H ${endX} V ${endY}`
              : `M ${startX} ${startY} C ${startX} ${startY + 46}, ${endX} ${endY - 46}, ${endX} ${endY}`;
            const label = edge.labels.join(" / ");
            const labelX = (startX + endX) / 2;
            const labelY = endY >= startY ? midY - 8 : (startY + endY) / 2;
            const labelWidth = Math.max(44, label.length * 8 + 18);
            return <g key={`${edge.from}-${edge.to}`}>
              <path d={path} className={label ? "flow-edge branch" : "flow-edge"} markerEnd={`url(#authoring-flow-arrow${label ? "-branch" : ""})`} />
              {label && <g className="flow-edge-label">
                <rect x={labelX - labelWidth / 2} y={labelY - 14} width={labelWidth} height="20" rx="7" />
                <text x={labelX} y={labelY} textAnchor="middle">{label}</text>
              </g>}
            </g>;
          })}
        </g>
        <g className="flow-nodes">
          {nodes.map((node) => {
            const position = layout.positions.get(node.id);
            if (!position) return null;
            const edges = outgoing(node).filter((edge) => edge.target);
            const label = nodeTypeLabel[node.type] || node.type;
            return <foreignObject key={node.id} x={position.x} y={position.y} width={FLOW_NODE_WIDTH} height={FLOW_NODE_HEIGHT}>
              <button type="button" className={`flow-node-card ${node.id === entryNode ? "entry" : ""} ${node.id === currentId ? "current" : ""} ${node.type}`} onClick={() => onSelect(node.id)} aria-label={`${node.id} ${label}`}>
                <div className="flow-node-head"><code>{node.id}</code><span className="flow-node-type">{label}</span></div>
                <strong>{node.speaker || "話者未設定"}</strong>
                {node.source_unit_id && <small className="flow-node-unit">{node.source_unit_id}</small>}
                <p>{nodeText(node).replace(/\s+/g, " ").slice(0, 88)}{nodeText(node).length > 88 ? "…" : ""}</p>
                {edges.length > 0 && <div className="flow-node-ports">{edges.map((edge) => <span key={`${node.id}-${edge.label}`}>{edge.label} → {edge.target || "未設定"}</span>)}</div>}
              </button>
            </foreignObject>;
          })}
        </g>
      </svg>
    </div>
  </div>;
}

function issue(level: ValidationIssue["level"], message: string, nodeId?: string): ValidationIssue {
  return { level, message, nodeId };
}

function validatePack(pack: AuthoringPack): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = Array.isArray(pack.nodes) ? pack.nodes : [];
  const nodeIds = new Set<string>();
  const characterKeys = new Set(pack.characters.flatMap((character) => [character.character_id, character.name]));
  const unitIds = new Set(pack.experience_timeline.map((unit) => unit.unit_id));
  const stateKeys = new Set([
    ...pack.state_schema.variables.map((variable) => variable.key),
    ...pack.state_schema.flags.map((flag) => flag.key)
  ]);
  if (pack.format !== "pne_statekit_pack") issues.push(issue("error", "formatがpne_statekit_packではありません"));
  if (!pack.entry_node || !nodes.some((node) => node.id === pack.entry_node)) issues.push(issue("error", `entry_node「${pack.entry_node || "未指定"}」がnodesに存在しません`));
  for (const node of nodes) {
    if (!node.id) { issues.push(issue("error", "Node IDが空です")); continue; }
    if (nodeIds.has(node.id)) issues.push(issue("error", `Node ID「${node.id}」が重複しています`, node.id));
    nodeIds.add(node.id);
    if (node.speaker && !characterKeys.has(node.speaker) && node.speaker !== "NARRATOR" && node.speaker !== "？？？") issues.push(issue("warning", `話者「${node.speaker}」がcharactersにありません`, node.id));
    if (node.source_unit_id && !unitIds.has(node.source_unit_id)) issues.push(issue("warning", `source_unit_id「${node.source_unit_id}」がexperience_timelineにありません`, node.id));
    for (const edge of outgoing(node)) if (edge.target && !nodes.some((candidate) => candidate.id === edge.target)) issues.push(issue("error", `遷移先「${edge.target}」が存在しません`, node.id));
    if (node.type === "reaction" || node.type === "reaction_prompt") {
      for (const input of INPUTS) if (!node.reaction_window?.branches?.[input]) issues.push(issue("error", `${input}の遷移先がありません`, node.id));
    }
    for (const key of Object.keys(node.state_updates || {})) if (!stateKeys.has(key)) issues.push(issue("error", `未定義state「${key}」を更新しています`, node.id));
    if (!node.text.trim()) issues.push(issue("warning", "本文が空です", node.id));
  }
  for (const character of pack.characters) if (!pack.character_timelines.some((timeline) => timeline.character_id === character.character_id)) issues.push(issue("warning", `Character Timelineがありません: ${character.name}`));
  for (const link of pack.experience_links) {
    if (!unitIds.has(link.from_unit_id)) issues.push(issue("error", `Unitリンク元「${link.from_unit_id}」が存在しません`));
    if (!unitIds.has(link.to_unit_id)) issues.push(issue("error", `Unitリンク先「${link.to_unit_id}」が存在しません`));
  }
  return issues;
}

function applyNodeEffects(runtime: Record<string, unknown>, node: AuthoringNode): Record<string, unknown> {
  const next = clone(runtime);
  for (const [key, value] of Object.entries(node.state_updates || {})) {
    if (typeof value === "number" && typeof next[key] === "number") next[key] = Number(next[key]) + value;
    else next[key] = clone(value);
  }
  if (Object.keys(node.memory_updates || {}).length) next.memory = { ...(next.memory as Record<string, unknown> || {}), ...clone(node.memory_updates) };
  return next;
}

function projectIdFor(pack: AuthoringPack): string {
  const source = `${pack.meta.title || "untitled"}-${pack.meta.version || "draft"}`.toLowerCase();
  let hash = 2166136261;
  for (const character of source) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  const slug = source.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56) || "project";
  return `${slug}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function AuthoringScreen() {
  const [pack, setPack] = useState<AuthoringPack>(() => clone(SAMPLE_AUTHORING_PACK));
  const [tab, setTab] = useState<AuthoringTab>("characters");
  const [selectedNodeId, setSelectedNodeId] = useState(SAMPLE_AUTHORING_PACK.entry_node);
  const [selectedCharacterId, setSelectedCharacterId] = useState(SAMPLE_AUTHORING_PACK.characters[0]?.character_id || "");
  const [runtime, setRuntime] = useState<RuntimeSnapshot>(() => ({ currentId: SAMPLE_AUTHORING_PACK.entry_node, runtime: clone(SAMPLE_AUTHORING_PACK.runtime_state), path: [SAMPLE_AUTHORING_PACK.entry_node] }));
  const [fileName, setFileName] = useState(() => suggestedScriptFileName(SAMPLE_AUTHORING_PACK.meta.title));
  const [showNewScriptDialog, setShowNewScriptDialog] = useState(false);
  const [newScriptTitle, setNewScriptTitle] = useState("新しい台本");
  const [newScriptFileName, setNewScriptFileName] = useState("新しい台本.json");
  const [newScriptError, setNewScriptError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("サンプルを読み込みました");
  const [showRaw, setShowRaw] = useState(false);
  const issues = useMemo(() => validatePack(pack), [pack]);
  const selectedNode = pack.nodes.find((node) => node.id === selectedNodeId) || pack.nodes[0];
  const currentRuntimeNode = pack.nodes.find((node) => node.id === runtime.currentId) || pack.nodes[0];
  const selectedCharacter = pack.characters.find((character) => character.character_id === selectedCharacterId) || pack.characters[0];
  const selectedNodeCharacter = pack.characters.find((character) => character.name === selectedNode?.speaker || character.character_id === selectedNode?.speaker);

  useEffect(() => {
    let active = true;
    platform.authoringLoad(projectIdFor(SAMPLE_AUTHORING_PACK)).then((stored) => {
      if (!active || !stored) return;
      const restored = normalizeImportedJson(stored, "保存済みJSON");
      setPack(restored);
      setSelectedNodeId(restored.entry_node);
      setSelectedCharacterId(restored.characters[0]?.character_id || "");
      setRuntime({ currentId: restored.entry_node, runtime: clone(restored.runtime_state), path: [restored.entry_node] });
      setFileName(suggestedScriptFileName(restored.meta.title));
      setMessage("前回の下書きを読み込みました");
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const updatePack = (updater: (draft: AuthoringPack) => void) => {
    setPack((current) => { const next = clone(current); updater(next); return next; });
    setDirty(true);
  };

  const selectNode = (id: string) => { setSelectedNodeId(id); setTab("script"); };

  const resetRuntime = () => {
    const entry = pack.nodes.find((node) => node.id === pack.entry_node);
    const initial = entry ? applyNodeEffects(clone(pack.runtime_state), entry) : clone(pack.runtime_state);
    setRuntime({ currentId: pack.entry_node, runtime: initial, path: [pack.entry_node] });
  };

  const transition = (input?: string) => {
    const node = pack.nodes.find((candidate) => candidate.id === runtime.currentId);
    if (!node) return;
    const target = node.reaction_window?.branches?.[input || "UNKNOWN"] || node.reaction_window?.branches?.UNKNOWN || node.reaction_window?.branches?.SILENT || outgoing(node)[0]?.target;
    if (!target) { setMessage("このノードには遷移先がありません"); return; }
    const nextNode = pack.nodes.find((candidate) => candidate.id === target);
    if (!nextNode) { setMessage(`遷移先 ${target} が存在しません`); return; }
    setRuntime({ currentId: nextNode.id, runtime: applyNodeEffects(runtime.runtime, nextNode), path: [...runtime.path, nextNode.id] });
    setSelectedNodeId(nextNode.id);
  };

  const backRuntime = () => {
    if (runtime.path.length < 2) return;
    const path = runtime.path.slice(0, -1);
    let state = clone(pack.runtime_state);
    for (const id of path) { const node = pack.nodes.find((candidate) => candidate.id === id); if (node) state = applyNodeEffects(state, node); }
    setRuntime({ currentId: path.at(-1) || pack.entry_node, runtime: state, path });
    setSelectedNodeId(path.at(-1) || pack.entry_node);
  };

  const runPreset = (input: string) => {
    let id = pack.entry_node;
    let state = clone(pack.runtime_state);
    const path: string[] = [];
    for (let guard = 0; guard < 1000; guard += 1) {
      const node = pack.nodes.find((candidate) => candidate.id === id);
      if (!node) break;
      path.push(node.id); state = applyNodeEffects(state, node);
      if (node.type === "end" || !outgoing(node).length) break;
      id = node.reaction_window?.branches?.[input] || node.reaction_window?.branches?.UNKNOWN || node.reaction_window?.branches?.SILENT || outgoing(node)[0]?.target || "";
      if (!id) break;
    }
    setRuntime({ currentId: id || pack.entry_node, runtime: state, path });
    setSelectedNodeId(id || pack.entry_node);
    setMessage(`${input}プリセット: ${path.length}ノードを走査しました${path.at(-1) === "END" ? "（完走）" : ""}`);
  };

  const save = async () => {
    try { await platform.authoringSave(projectIdFor(pack), pack); setDirty(false); setMessage("正本JSONを保存しました"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "保存に失敗しました"); }
  };

  const saveAsFile = async () => {
    let normalizedFileName: string;
    try { normalizedFileName = normalizeScriptFileName(fileName); }
    catch (error) { setMessage(error instanceof Error ? error.message : "ファイル名を確認してください"); return; }

    const contents = `${JSON.stringify(pack, null, 2)}\n`;
    try {
      const picker = (window as WindowWithSavePicker).showSaveFilePicker;
      if (picker) {
        const handle = await picker({
          suggestedName: normalizedFileName,
          types: [{ description: "P.N.E. 台本JSON", accept: { "application/json": [".json"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(contents);
        await writable.close();
      } else {
        const blob = new Blob([contents], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = normalizedFileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setFileName(normalizedFileName);
      setDirty(false);
      setMessage(`${normalizedFileName}として保存しました`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessage("ファイル保存をキャンセルしました");
      } else {
        setMessage(error instanceof Error ? error.message : "ファイル保存に失敗しました");
      }
    }
  };

  const openNewScriptDialog = () => {
    if (dirty && !window.confirm("保存していない変更があります。新しい台本を作成しますか？")) return;
    setNewScriptTitle("新しい台本");
    setNewScriptFileName("新しい台本.json");
    setNewScriptError("");
    setShowNewScriptDialog(true);
  };

  const createNewScript = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newScriptTitle.trim();
    if (!title) { setNewScriptError("台本名を入力してください"); return; }
    let normalizedFileName: string;
    try { normalizedFileName = normalizeScriptFileName(newScriptFileName); }
    catch (error) { setNewScriptError(error instanceof Error ? error.message : "ファイル名を確認してください"); return; }

    const freshPack = createEmptyAuthoringPack(title);
    setPack(freshPack);
    setSelectedNodeId(freshPack.entry_node);
    setSelectedCharacterId("");
    setRuntime({ currentId: freshPack.entry_node, runtime: clone(freshPack.runtime_state), path: [freshPack.entry_node] });
    setFileName(normalizedFileName);
    setDirty(true);
    setTab("script");
    setShowRaw(false);
    setShowNewScriptDialog(false);
    setMessage(`${normalizedFileName}を新規作成しました`);
  };

  const importPack = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    try {
      const parsed = parseJsonText(await file.text(), file.name);
      const imported = normalizeImportedJson(parsed, file.name);
      setPack(imported); setSelectedNodeId(imported.entry_node); setSelectedCharacterId(imported.characters[0]?.character_id || "");
      setRuntime({ currentId: imported.entry_node, runtime: clone(imported.runtime_state), path: [imported.entry_node] });
      setFileName(suggestedScriptFileName(file.name.replace(/\.json$/i, "")));
      setDirty(true); setMessage(`${file.name}を読み込みました（不足項目は補完して検証中）`);
    } catch (error) { console.error("Authoring JSON import failed:", error); setMessage(error instanceof Error ? error.message : "JSONを読み込めませんでした"); }
  };

  const updateNode = (patch: Partial<AuthoringNode>) => updatePack((draft) => {
    const node = draft.nodes.find((candidate) => candidate.id === selectedNodeId); if (node) Object.assign(node, patch);
  });

  const addNode = () => {
    let index = pack.nodes.length + 1; let id = `NODE_${String(index).padStart(3, "0")}`;
    while (pack.nodes.some((node) => node.id === id)) { index += 1; id = `NODE_${String(index).padStart(3, "0")}`; }
    updatePack((draft) => draft.nodes.push({ id, source_unit_id: draft.experience_timeline[0]?.unit_id, type: "normal", speaker: draft.characters[0]?.character_id || "", text: "新しい台詞を入力してください。", next: null }));
    setSelectedNodeId(id); setTab("script");
  };

  const deleteNode = () => {
    if (!selectedNode || selectedNode.id === pack.entry_node) { setMessage("entry nodeは削除できません"); return; }
    updatePack((draft) => { draft.nodes = draft.nodes.filter((node) => node.id !== selectedNode.id); draft.nodes.forEach((node) => { if (node.next === selectedNode.id) node.next = null; if (node.reaction_window) for (const input of INPUTS) if (node.reaction_window.branches[input] === selectedNode.id) node.reaction_window.branches[input] = ""; }); });
    setSelectedNodeId(pack.entry_node);
  };

  const updateCharacter = (patch: Partial<AuthoringCharacter>) => updatePack((draft) => { const character = draft.characters.find((candidate) => candidate.character_id === selectedCharacterId); if (character) Object.assign(character, patch); });
  const updateNodeCharacterPreset = (presetId: string) => {
    const character = pack.characters.find((candidate) => candidate.name === selectedNode?.speaker || candidate.character_id === selectedNode?.speaker);
    if (character) updatePack((draft) => { const target = draft.characters.find((candidate) => candidate.character_id === character.character_id); if (target) target.voice_preset_id = presetId; });
  };
  const applyGeneratedVoice = (candidate: VoiceCandidateAudio, round: VoiceRoundWithAudio, generationManifest: VoiceGenerationManifest) => {
    if (!candidate.trimmed_audio_key) return;
    const currentAudio = selectedNode?.audio || {};
    const currentSequence = Array.isArray(currentAudio.sequence) ? currentAudio.sequence : [];
    const sequence = currentSequence.filter((part) => !(isRecord(part) && (typeof part.clip_id === "string" || typeof part.src === "string")));
    sequence.push({ clip_id: `pne-generated:${candidate.trimmed_audio_key}` });
    const { src: _src, sequence: _sequence, ...audioMetadata } = currentAudio;
    updatePack((draft) => {
      const node = draft.nodes.find((entry) => entry.id === selectedNode?.id);
      if (node) node.audio = { ...audioMetadata, sequence, voice: { source: "generated", clip_id: candidate.candidate_id, generation_unit_id: round.generation_unit_id, selected_candidate_id: candidate.candidate_id, trimmed_audio_key: candidate.trimmed_audio_key } };
      draft.voice_generation = generationManifest;
    });
    setMessage(`${candidate.variant}候補を${selectedNode?.id || "ノード"}へ採用しました`);
  };
  const updateProfile = (key: string, value: string) => updateCharacter({ profile: { ...(selectedCharacter?.profile || {}), [key]: value } });
  const selectedTimeline: CharacterTimeline | undefined = pack.character_timelines.find((timeline) => timeline.character_id === selectedCharacterId);
  const updateBeat = (index: number, patch: Partial<TimelineBeat>) => updatePack((draft) => { const timeline = draft.character_timelines.find((candidate) => candidate.character_id === selectedCharacterId); if (timeline?.beats[index]) Object.assign(timeline.beats[index], patch); });

  const renderCharacterView = () => <div className="authoring-character-layout">
    <aside className="authoring-list-panel">
      <div className="authoring-list-head"><span>CHARACTERS</span><button className="button compact secondary" onClick={() => { const id = `char_${pack.characters.length + 1}`; updatePack((draft) => draft.characters.push({ character_id: id, name: "新しいキャラクター", color: "purple", profile: {} })); setSelectedCharacterId(id); }}>＋</button></div>
      {pack.characters.map((character) => <button key={character.character_id} className={`authoring-list-item ${character.character_id === selectedCharacterId ? "active" : ""}`} onClick={() => setSelectedCharacterId(character.character_id)}><span className={`character-dot ${character.color || "purple"}`} /><span><b>{character.name}</b><small>{character.character_id}</small></span></button>)}
    </aside>
    {selectedCharacter && <section className="authoring-detail-panel">
      <div className="authoring-detail-title"><div><p className="eyebrow">CHARACTER TIMELINE</p><h2>{selectedCharacter.name}</h2><code>{selectedCharacter.character_id}</code></div><button className="button secondary" onClick={() => setTab("flow")}>体験フローを見る →</button></div>
      <div className="authoring-form-grid">
        <label>表示名<input value={selectedCharacter.name} onChange={(event) => updateCharacter({ name: event.target.value })} /></label>
        <label>キャラクターID<input value={selectedCharacter.character_id} onChange={(event) => { const nextId = event.target.value; updateCharacter({ character_id: nextId }); setSelectedCharacterId(nextId); }} /></label>
        <label>一人称（文脈生成）<input value={selectedCharacter.first_person || ""} placeholder="例：私 / 僕 / 俺" onChange={(event) => updateCharacter({ first_person: event.target.value || undefined })} /></label>
      </div>
      <div className="authoring-profile-card"><div className="authoring-section-head"><h3>プロフィール</h3><span>作品設計の原本</span></div><div className="authoring-form-grid two">
        {([["role", "役割"], ["public_face", "表の人物像"], ["hidden_truth", "裏の真実"], ["desire", "欲求"], ["fear", "恐れ"], ["core_wound", "核心となる傷"], ["relationship_axis", "関係性"]] as const).map(([key, label]) => <label key={key}>{label}<textarea rows={2} value={selectedCharacter.profile[key] || ""} onChange={(event) => updateProfile(key, event.target.value)} /></label>)}
      </div></div>
      <div className="authoring-profile-card"><div className="authoring-section-head"><h3>VoicePreset</h3><span>生成時の既定参照音声</span></div><div className="voice-preset-rail character-voice-preset-rail" role="listbox" aria-label="キャラクターの音声プリセット">
        {DEFAULT_VOICE_PRESETS.map((preset) => <button type="button" role="option" aria-selected={selectedCharacter.voice_preset_id === preset.voice_preset_id} key={preset.voice_preset_id} className={`voice-preset-card ${selectedCharacter.voice_preset_id === preset.voice_preset_id ? "active" : ""}`} onClick={() => updateCharacter({ voice_preset_id: preset.voice_preset_id })}><span className="voice-preset-group">{preset.group}</span><b>{preset.label}</b><small>{preset.tags.join(" · ")}</small></button>)}
      </div><p className="voice-preset-note">参照音声ファイルを台本ごとに差し替える場合は、台詞・Runtime画面の参照音声選択を使います。</p></div>
      <div className="authoring-profile-card"><div className="authoring-section-head"><h3>時間による変化</h3><button className="button compact secondary" onClick={() => updatePack((draft) => { const timeline = draft.character_timelines.find((candidate) => candidate.character_id === selectedCharacterId); if (timeline) timeline.beats.push({ phase: "mid", label: "新しいBeat", key_event: "主要イベントを入力", inner_state: "内面状態を入力" }); else draft.character_timelines.push({ character_id: selectedCharacterId, beats: [{ phase: "present_start", label: "新しいBeat", key_event: "主要イベントを入力" }] }); })}>＋ Beat</button></div><div className="timeline-editor">{(selectedTimeline?.beats || []).map((beat, index) => <article className="timeline-editor-card" key={`${selectedCharacterId}-${index}`}><div className="timeline-editor-top"><select value={beat.phase} onChange={(event) => updateBeat(index, { phase: event.target.value })}><option value="past">past</option><option value="present_start">present_start</option><option value="mid">mid</option><option value="end">end</option></select><input value={beat.label} onChange={(event) => updateBeat(index, { label: event.target.value })} /></div><label>主要イベント<input value={beat.key_event} onChange={(event) => updateBeat(index, { key_event: event.target.value })} /></label><label>内面状態<textarea rows={2} value={beat.inner_state || ""} onChange={(event) => updateBeat(index, { inner_state: event.target.value })} /></label></article>)}</div></div>
    </section>}
  </div>;

  const renderFlowView = () => <div className="authoring-flow-view">
    <div className="authoring-flow-summary"><div><p className="eyebrow">STORY STRUCTURE</p><h2>{pack.meta.title}</h2><p>Runtimeの実際の遷移を、分岐ラベル付きのフロー図で表示しています。</p></div><div className="authoring-stat"><b>{pack.experience_timeline.length}</b><span>Experience Units</span></div><div className="authoring-stat"><b>{pack.experience_links.length}</b><span>Links</span></div><div className="authoring-stat"><b>{pack.nodes.length}</b><span>Runtime Nodes</span></div></div>
    <div className="authoring-node-flow"><div className="authoring-section-head"><h3>Runtime構造フロー</h3><span>next / next_ids / reaction_window.branches</span></div><FlowGraph nodes={pack.nodes} entryNode={pack.entry_node} currentId={runtime.currentId} onSelect={selectNode} /></div>
    <div className="authoring-flow-units"><div className="authoring-section-head"><h3>Experience Units</h3><span>クリックで先頭Nodeの台本編集へ</span></div><div className="authoring-flow-unit-grid">{pack.experience_timeline.slice().sort((a, b) => a.order - b.order).map((unit) => <button className="authoring-unit-card compact" key={unit.unit_id} onClick={() => { const node = pack.nodes.find((candidate) => candidate.source_unit_id === unit.unit_id); if (node) selectNode(node.id); }}><div className="unit-card-head"><code>{unit.unit_id}</code><span>{unit.route_id}</span></div><h3>{unit.unit}</h3><div className="unit-state"><span>{unit.viewer_state_start}</span><b>→</b><span>{unit.viewer_state_end}</span></div><div className="unit-inversion">認知反転：{unit.inversion}</div></button>)}</div></div>
  </div>;

  const renderScriptView = () => <div className="authoring-script-layout">
    <aside className="authoring-list-panel script-list"><div className="authoring-list-head"><span>NODES · {pack.nodes.length}</span><button className="button compact primary" onClick={addNode}>＋</button></div><input className="authoring-search" placeholder="ID・話者・本文を検索" onChange={(event) => { const query = event.target.value.toLocaleLowerCase(); document.querySelectorAll<HTMLElement>("[data-node-search]").forEach((element) => { element.hidden = !element.dataset.nodeSearch?.includes(query); }); }} />{pack.nodes.map((node) => <button data-node-search={`${node.id} ${node.speaker || ""} ${node.text}`.toLocaleLowerCase()} key={node.id} className={`authoring-list-item ${node.id === selectedNodeId ? "active" : ""}`} onClick={() => setSelectedNodeId(node.id)}><span className={`node-type-mark ${node.type}`} /><span><b>{node.id}</b><small>{node.speaker || "—"}｜{nodeText(node).replace(/\s+/g, " ").slice(0, 38)}</small></span></button>)}</aside>
    <section className="authoring-editor-panel">{selectedNode && <><div className="authoring-detail-title"><div><p className="eyebrow">SCRIPT NODE</p><h2>{selectedNode.id}</h2><span className="node-type-chip">{nodeTypeLabel[selectedNode.type] || selectedNode.type}</span></div><div className="editor-actions"><button className="button secondary" onClick={deleteNode}>削除</button><button className="button primary" onClick={save}>保存</button></div></div><div className="authoring-form-grid"><label>Node ID<input value={selectedNode.id} onChange={(event) => { const nextId = event.target.value; updatePack((draft) => { const node = draft.nodes.find((candidate) => candidate.id === selectedNode.id); if (node) node.id = nextId; if (draft.entry_node === selectedNode.id) draft.entry_node = nextId; draft.nodes.forEach((candidate) => { if (candidate.next === selectedNode.id) candidate.next = nextId; if (candidate.reaction_window) for (const input of INPUTS) if (candidate.reaction_window.branches[input] === selectedNode.id) candidate.reaction_window.branches[input] = nextId; }); }); setSelectedNodeId(nextId); }} /></label><label>Type<select value={selectedNode.type} onChange={(event) => updateNode({ type: event.target.value as AuthoringNode["type"] })}>{Object.entries(nodeTypeLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>話者<select value={selectedNode.speaker || ""} onChange={(event) => updateNode({ speaker: event.target.value })}><option value="">話者未設定</option>{pack.characters.map((character) => <option key={character.character_id} value={character.name}>{character.name}</option>)}<option value="NARRATOR">NARRATOR</option></select></label><label>所属Experience Unit<select value={selectedNode.source_unit_id || ""} onChange={(event) => updateNode({ source_unit_id: event.target.value })}><option value="">未設定</option>{pack.experience_timeline.map((unit) => <option key={unit.unit_id} value={unit.unit_id}>{unit.unit} · {unit.unit_id}</option>)}</select></label></div><label className="authoring-wide-field">台詞・地の文<textarea className="script-textarea" rows={11} value={selectedNode.text} onChange={(event) => updateNode({ text: event.target.value })} /></label><div className="authoring-form-grid two"><label>演技トーン<input value={String(selectedNode.performance?.tone || "")} onChange={(event) => updateNode({ performance: { ...(selectedNode.performance || {}), tone: event.target.value } })} /></label><label>演技テンポ<input value={String(selectedNode.performance?.pace || "")} onChange={(event) => updateNode({ performance: { ...(selectedNode.performance || {}), pace: event.target.value } })} /></label></div>{(selectedNode.type === "reaction" || selectedNode.type === "reaction_prompt") && <div className="reaction-editor"><div className="authoring-section-head"><h3>Reaction Window</h3><span>{selectedNode.reaction_window?.window_ms || 0} ms</span></div><div className="authoring-form-grid"><label>待機時間<input type="number" value={selectedNode.reaction_window?.window_ms || 0} onChange={(event) => updateNode({ reaction_window: { window_ms: Number(event.target.value), branches: { ...(selectedNode.reaction_window?.branches || {}) } } })} /></label>{INPUTS.map((input) => <label key={input}>{input}<select value={selectedNode.reaction_window?.branches?.[input] || ""} onChange={(event) => updateNode({ reaction_window: { window_ms: selectedNode.reaction_window?.window_ms || 0, branches: { ...(selectedNode.reaction_window?.branches || {}), [input]: event.target.value } } })}><option value="">未設定</option>{pack.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label>)}</div></div>}{selectedNode.type !== "end" && !(selectedNode.type === "reaction" || selectedNode.type === "reaction_prompt") && <label>次ノード<select value={selectedNode.next || ""} onChange={(event) => updateNode({ next: event.target.value || null })}><option value="">終端</option>{pack.nodes.map((node) => <option key={node.id} value={node.id}>{node.id}</option>)}</select></label>}<div className="editor-actions bottom"><button className="button secondary" onClick={() => setTab("flow")}>構造ビューで確認</button><button className="button primary" onClick={save}>変更を保存</button></div></>}</section>
    <aside className="authoring-runtime-panel"><div className="authoring-section-head"><h3>Runtime Preview</h3><span>{runtime.path.length} nodes</span></div><div className="runtime-current"><span className="node-type-chip">現在位置</span><code>{currentRuntimeNode?.id}</code><h3>{currentRuntimeNode?.speaker || "話者未設定"}</h3><p>{currentRuntimeNode ? nodeText(currentRuntimeNode) : ""}</p></div><div className="runtime-actions"><button className="button secondary" onClick={backRuntime} disabled={runtime.path.length < 2}>← 戻る</button><button className="button secondary" onClick={resetRuntime}>↺ リセット</button>{currentRuntimeNode && currentRuntimeNode.type !== "end" && !currentRuntimeNode.reaction_window && <button className="button primary" onClick={() => transition()}>次へ →</button>}</div>{currentRuntimeNode?.reaction_window && <><p className="runtime-prompt">反応入力をシミュレーション</p><div className="runtime-input-grid">{INPUTS.map((input) => <button key={input} className="button secondary" onClick={() => transition(input)}>{input}<small>{currentRuntimeNode.reaction_window?.branches?.[input] || "未設定"}</small></button>)}</div></>}<div className="runtime-state"><div className="authoring-section-head"><h3>Current state</h3><span>実行中</span></div><pre>{JSON.stringify(runtime.runtime, null, 2)}</pre></div><div className="runtime-presets"><div className="authoring-section-head"><h3>Route Presets</h3><span>一括走査</span></div>{INPUTS.map((input) => <button key={input} onClick={() => runPreset(input)}>{input}</button>)}</div><div className="runtime-path"><h3>通過経路</h3><p>{runtime.path.join(" → ")}</p></div></aside>
  </div>;

  return <div className="page authoring-page"><PageHeader eyebrow="AUTHORING STUDIO" title="ステート台本パック制作"><div className="authoring-toolbar"><label className="button secondary">JSONを開く<input type="file" accept=".json,application/json" hidden onChange={importPack} /></label><button className="button secondary" onClick={openNewScriptDialog}>＋ 台本を新規作成</button><label className="authoring-file-name-field"><span>ファイル名</span><input aria-label="保存するファイル名" value={fileName} onChange={(event) => setFileName(event.target.value)} onBlur={() => { try { setFileName(normalizeScriptFileName(fileName)); } catch { /* 保存時にメッセージを表示 */ } }} /></label><button className="button secondary" onClick={saveAsFile}>名前を付けて保存</button><button className="button primary" onClick={save}>下書き保存{dirty ? "*" : ""}</button></div></PageHeader><div className="authoring-status"><span className={issues.some((item) => item.level === "error") ? "status-error" : "status-ok"}>●</span><b>{pack.meta.title}</b><span>{pack.meta.version}</span><span>{message}</span><span className="status-count">{issues.filter((item) => item.level === "error").length} errors · {issues.filter((item) => item.level === "warning").length} warnings</span></div><nav className="authoring-tabs" aria-label="制作ビュー"><button className={tab === "characters" ? "active" : ""} onClick={() => setTab("characters")}>キャラ設定</button><button className={tab === "flow" ? "active" : ""} onClick={() => setTab("flow")}>体験フロー</button><button className={tab === "script" ? "active" : ""} onClick={() => setTab("script")}>台本・Runtime</button></nav>{tab === "characters" ? renderCharacterView() : tab === "flow" ? renderFlowView() : renderScriptView()}{tab === "script" && selectedNode && <VoiceGenerationPanel projectId={projectIdFor(pack)} pack={pack} selectedNode={selectedNode} selectedCharacter={selectedNodeCharacter} onAssignPreset={updateNodeCharacterPreset} onApplyCandidate={applyGeneratedVoice} />}<section className="authoring-validation"><div><b>検証結果</b><span>クリック可能なエラーは該当ノードへ移動</span></div><div className="validation-list">{issues.length ? issues.slice(0, 8).map((item, index) => <button key={`${item.message}-${index}`} className={`validation-item ${item.level}`} onClick={() => item.nodeId && selectNode(item.nodeId)}><span>{item.level === "error" ? "×" : "△"}</span><span>{item.message}</span>{item.nodeId && <code>{item.nodeId}</code>}</button>) : <span className="validation-clean">構造検証に問題ありません</span>}{issues.length > 8 && <span className="validation-more">他 {issues.length - 8} 件</span>}</div></section><button className="raw-toggle" onClick={() => setShowRaw((value) => !value)}>{showRaw ? "Raw JSONを閉じる" : "Raw JSONを表示"}</button>{showRaw && <pre className="authoring-raw-json">{JSON.stringify(pack, null, 2)}</pre>}<div className="authoring-footer"><Link to="/library">← ライブラリへ</Link><span>同じ正本JSONを、構造ビューと台本・Runtimeビューで共有しています。</span></div>{showNewScriptDialog && <div className="authoring-dialog-backdrop" role="presentation"><div className="authoring-dialog" role="dialog" aria-modal="true" aria-labelledby="new-script-dialog-title"><div className="authoring-detail-title"><div><p className="eyebrow">NEW SCRIPT</p><h2 id="new-script-dialog-title">台本を新規作成</h2></div><button type="button" className="dialog-close" aria-label="閉じる" onClick={() => setShowNewScriptDialog(false)}>×</button></div><p className="authoring-dialog-description">空の台本パックを作成します。作成後にノード・キャラクターを追加して、指定したファイル名で保存できます。</p><form onSubmit={createNewScript}><label>台本名<input autoFocus value={newScriptTitle} onChange={(event) => setNewScriptTitle(event.target.value)} /></label><label>保存ファイル名<input value={newScriptFileName} onChange={(event) => setNewScriptFileName(event.target.value)} /></label>{newScriptError && <p className="authoring-dialog-error" role="alert">{newScriptError}</p>}<div className="editor-actions bottom"><button type="button" className="button secondary" onClick={() => setShowNewScriptDialog(false)}>キャンセル</button><button type="submit" className="button primary">作成する</button></div></form></div></div>}</div>;
}
