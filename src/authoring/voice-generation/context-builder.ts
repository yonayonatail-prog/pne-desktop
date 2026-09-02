import type { AuthoringNode, TrimPlan } from "../types";
import type { ContextTake, DialogueGenerationUnit } from "./types";

function textOf(node: AuthoringNode | undefined): string {
  return String(node?.text || "").trim();
}

function joinContext(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n").trim();
}

function makeTrimPlan(prefix: string, spoken: string, suffix: string): TrimPlan {
  const prefixChars = [...prefix.replace(/\s+/g, "")].length;
  const spokenChars = [...spoken.replace(/\s+/g, "")].length;
  const suffixChars = [...suffix.replace(/\s+/g, "")].length;
  const totalChars = Math.max(1, prefixChars + spokenChars + suffixChars);
  return {
    enabled: true,
    prefix_chars: prefixChars,
    spoken_chars: spokenChars,
    suffix_chars: suffixChars,
    total_chars: totalChars,
    predicted_start_ratio: prefixChars / totalChars,
    predicted_end_ratio: (prefixChars + spokenChars) / totalChars
  };
}

function makeTake(
  variant: ContextTake["variant"],
  kind: ContextTake["kind"],
  prefixParts: string[],
  spoken: string,
  suffixParts: string[]
): ContextTake {
  const prefix = joinContext(prefixParts);
  const suffix = joinContext(suffixParts);
  const generationText = joinContext([prefix, spoken, suffix]);
  return {
    variant,
    kind,
    prefix_context: prefix,
    spoken_text: spoken,
    suffix_context: suffix,
    generation_text: generationText,
    trim_plan: makeTrimPlan(prefix, spoken, suffix)
  };
}

function nextOf(nodes: AuthoringNode[], node: AuthoringNode): AuthoringNode | undefined {
  const targetId = node.next_ids?.[0] || node.next || "";
  return nodes.find((candidate) => candidate.id === targetId);
}

function previousOf(nodes: AuthoringNode[], node: AuthoringNode): AuthoringNode | undefined {
  return nodes.find((candidate) => {
    const targets = candidate.next_ids?.length ? candidate.next_ids : candidate.next ? [candidate.next] : [];
    return targets.includes(node.id);
  }) || nodes[Math.max(0, nodes.indexOf(node) - 1)];
}

export function buildContextVariants(nodes: AuthoringNode[], nodeId: string): DialogueGenerationUnit {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`生成対象ノード ${nodeId} が見つかりません`);
  const spoken = textOf(node);
  if (!spoken) throw new Error("生成対象の台詞が空です");

  const previous = previousOf(nodes, node);
  const next = nextOf(nodes, node);
  const previousText = previous?.speaker === node.speaker ? textOf(previous) : "";
  const nextText = next?.speaker === node.speaker ? textOf(next) : "";
  const performance = node.performance || {};
  const tone = String(performance.tone || "").trim();
  const pace = String(performance.pace || "").trim();
  const performanceHint = [tone && `感情は${tone}。`, pace && `読みのテンポは${pace}。`, "相手に向かって自然に話す。"].filter(Boolean).join(" ");

  const takes = [
    makeTake("A", "neutral", [previousText, "相手に向かって自然に話している。"], spoken, []),
    makeTake("B", "emotion", [previousText, performanceHint || "声に感情を込めて話す。"], spoken, [nextText]),
    makeTake("C", "scene", [previousText, "場面の状態を受け止めて話している。"], spoken, [nextText])
  ] as [ContextTake, ContextTake, ContextTake];

  return {
    generation_unit_id: `unit_${node.id}`,
    source_line_ids: [node.id],
    speaker_id: node.speaker || "",
    spoken_text: spoken,
    takes
  };
}
