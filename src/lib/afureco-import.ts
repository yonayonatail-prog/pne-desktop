import type { AfurecoProject, LineStatus, ScriptLine } from "../afureco/types";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);
const asText = (value: unknown): string => typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
const asPositiveNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

function parseJsonText(text: string, filename: string): unknown {
  const source = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = Number(message.match(/position\s+(\d+)/i)?.[1]);
    if (Number.isInteger(position)) {
      const before = source.slice(0, position);
      const line = before.split("\n").length;
      const column = position - before.lastIndexOf("\n");
      throw new Error(`${filename}: JSON構文エラー（${line}行 ${column}列）`);
    }
    throw new Error(`${filename}: JSONを解析できません`);
  }
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function slug(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "script";
}

function textFromDisplaySequence(sequence: unknown): string {
  if (!Array.isArray(sequence)) return "";
  return sequence.map((part) => {
    if (typeof part === "string") {
      const textPart = part.match(/@\{text=([\s\S]*?)\}/)?.[1];
      return textPart ?? part;
    }
    if (!isRecord(part)) return "";
    if (typeof part.text === "string") return part.text;
    if (part.name_slot_id) return "{{name}}";
    return "";
  }).join("").trim();
}

function textFromLine(value: JsonRecord): string {
  const directKeys = ["text", "dialogue", "spoken_text", "spokenText", "display_text", "narrative_description"];
  for (const key of directKeys) {
    const text = asText(value[key]);
    if (text) return text;
  }
  return textFromDisplaySequence(value.display_sequence);
}

function rowsFromNodes(nodes: unknown[]): JsonRecord[] {
  const rows: JsonRecord[] = [];
  for (const rawNode of nodes) {
    if (!isRecord(rawNode)) continue;
    const nodeId = asText(rawNode.node_id || rawNode.id);
    const nestedLines = Array.isArray(rawNode.lines) ? rawNode.lines.filter(isRecord) : [];
    if (nestedLines.length) {
      for (const line of nestedLines) {
        rows.push({
          ...line,
          node_id: asText(line.node_id) || nodeId,
          state: line.state || rawNode.state,
          chapter: line.chapter || rawNode.chapter
        });
      }
      const narration = Array.isArray(rawNode.narration) ? rawNode.narration.filter(isRecord) : [];
      for (const item of narration) {
        rows.push({
          ...item,
          line_id: item.line_id || item.narration_id,
          node_id: nodeId,
          speaker: item.speaker || "NARRATOR",
          state: item.state || rawNode.state,
          chapter: item.chapter || rawNode.chapter
        });
      }
      continue;
    }
    rows.push(rawNode);
  }
  return rows;
}

function characterEntries(source: JsonRecord): Map<string, string> {
  const map = new Map<string, string>();
  const candidates = [source.characters, source.character_definitions, source.character_definition];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (!isRecord(item)) continue;
        const id = asText(item.character_id || item.id || item.name);
        const name = asText(item.name || item.display_name || item.label) || id;
        if (id && name) map.set(id, name);
      }
    } else if (isRecord(candidate)) {
      for (const [id, item] of Object.entries(candidate)) {
        const name = isRecord(item) ? asText(item.name || item.display_name || item.label) : asText(item);
        if (id && name) map.set(id, name);
      }
    }
  }
  return map;
}

function performanceDirection(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined && item !== null && String(item).trim());
  if (!entries.length) return undefined;
  return entries.map(([key, item]) => `${key}: ${String(item)}`).join(" / ");
}

function readLineStatus(value: unknown): LineStatus {
  return value === "IN_PROGRESS" || value === "SUBMITTED" || value === "REVISION_REQUESTED" || value === "APPROVED" ? value : "NOT_RECORDED";
}

function estimatedDurationMs(text: string): number {
  const spokenCharacters = text.replace(/\s/g, "").length;
  return Math.max(700, Math.round((spokenCharacters / 4.5) * 1000 + 500));
}

function lineRows(source: JsonRecord): JsonRecord[] {
  const direct = [source.lines, source.nodes, isRecord(source.scenario) ? source.scenario.nodes : undefined, isRecord(source.script) ? source.script.nodes : undefined];
  for (const candidate of direct) {
    if (Array.isArray(candidate)) {
      const rows = candidate === source.lines ? candidate.filter(isRecord) : rowsFromNodes(candidate);
      if (rows.length) return rows;
    }
  }

  if (Array.isArray(source.batches)) {
    const rows: JsonRecord[] = [];
    for (const batch of source.batches.filter(isRecord)) {
      const segments = Array.isArray(batch.source_segments) ? batch.source_segments.filter(isRecord) : [];
      if (segments.length) {
        segments.forEach((segment, index) => {
          const variant = Array.isArray(batch.context_variants) && isRecord(batch.context_variants[index]) ? batch.context_variants[index] : undefined;
          const seconds = variant ? asPositiveNumber(variant.seconds) : undefined;
          rows.push({
            ...segment,
            speaker: segment.speaker || batch.speaker,
            state: segment.state || batch.state,
            performance: Array.isArray(batch.performance) ? batch.performance[index] : batch.performance,
            expectedDurationMs: seconds ? seconds * 1000 : undefined
          });
        });
      } else if (asText(batch.spoken_text)) {
        rows.push(batch);
      }
    }
    return rows;
  }

  if (Array.isArray(source.items)) return source.items.filter(isRecord);
  return [];
}

function sourceRoot(value: unknown): JsonRecord {
  if (Array.isArray(value)) return { lines: value };
  if (!isRecord(value)) throw new Error("アフレコJSONはオブジェクトまたは配列で指定してください。");
  if (isRecord(value.project)) return { ...value, ...value.project };
  return value;
}

export function normalizeAfurecoProject(value: unknown, filename = "script.json"): AfurecoProject {
  const source = sourceRoot(value);
  const rows = lineRows(source);
  if (!rows.length) throw new Error(`${filename}: アフレコ用のセリフが見つかりません（lines / nodes / scenario.nodes を確認してください）`);

  const title = asText(source.projectName || source.workTitle || source.title || (isRecord(source.meta) ? source.meta.title : undefined)) || filename.replace(/\.json$/i, "") || "読み込み台本";
  const version = asText(source.scriptVersion || source.version || (isRecord(source.meta) ? source.meta.version : undefined) || source.schema_version) || "imported";
  const sourceId = asText(source.projectId || source.workId || (isRecord(source.meta) ? source.meta.id : undefined));
  const projectId = `afureco-import-${slug(sourceId || title)}-${hashText(`${filename}|${sourceId}|${version}`)}`;
  const characters = characterEntries(source);
  const seenIds = new Map<string, number>();
  const lines: ScriptLine[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const text = textFromLine(row);
    if (!text) continue;
    const rawId = asText(row.lineId || row.line_id || row.id || row.node_id) || `LINE_${String(index + 1).padStart(3, "0")}`;
    const rawNodeId = asText(row.nodeId || row.node_id || row.parent_node_id) || rawId;
    const occurrence = (seenIds.get(rawId) ?? 0) + 1;
    seenIds.set(rawId, occurrence);
    const lineId = `${projectId}.${slug(rawId)}${occurrence > 1 ? `-${occurrence}` : ""}`;
    const rawSpeaker = asText(row.speaker || row.speaker_name || row.character || row.character_id) || "NARRATOR";
    const speakerName = characters.get(rawSpeaker) || rawSpeaker;
    const characterId = asText(row.characterId || row.character_id) || rawSpeaker;
    const sceneId = asText(row.sceneId || row.scene_id || row.chapter || row.state || row.source_unit_id) || `scene-${String(index + 1).padStart(2, "0")}`;
    const sceneName = asText(row.sceneName || row.scene_name || row.chapter_name || row.chapter || row.state) || sceneId;
    const explicitDuration = asPositiveNumber(row.expectedDurationMs || row.expected_duration_ms || row.durationMs || row.duration_ms);
    const durationFromSeconds = asPositiveNumber(row.seconds) ? Number(row.seconds) * 1000 : undefined;
    const direction = performanceDirection(row.direction) || performanceDirection(row.performance);
    lines.push({
      lineId,
      nodeId: rawNodeId,
      sceneId,
      sceneName,
      characterId,
      speakerName,
      text,
      direction,
      expectedDurationMs: explicitDuration || durationFromSeconds || estimatedDurationMs(text),
      status: readLineStatus(row.status)
    });
  }

  if (!lines.length) throw new Error(`${filename}: 本文のあるセリフが見つかりません。`);
  const narratorNames = new Set(["NARRATOR", "ナレーター", "？？？"]);
  const speakers = [...new Set(lines.map((line) => line.speakerName).filter((speaker) => !narratorNames.has(speaker)))];
  const assignedCharacter = asText(source.assignedCharacter || source.assigned_character || source.character) || (speakers.length === 1 ? speakers[0] : "全キャラクター");

  return {
    projectId,
    projectName: asText(source.projectName) || `${title}・アフレコ案件`,
    workTitle: title,
    scriptVersion: version,
    assignedCharacter,
    actorName: "ローカル収録",
    state: "RECORDING",
    sourceFileName: filename,
    lines
  };
}

export function parseAfurecoProjectJson(text: string, filename = "script.json"): AfurecoProject {
  return normalizeAfurecoProject(parseJsonText(text, filename), filename);
}
