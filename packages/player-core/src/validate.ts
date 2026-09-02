import type { NameSlot, Scenario, ScenarioNode } from "./types";

export class ScenarioValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ScenarioValidationError";
  }
}

export function validateScenario(scenario: Scenario, slots: NameSlot[] = []): void {
  const problems: string[] = [];
  if (scenario.schema_version !== "1.0") problems.push("schema_version must be 1.0");
  const ids = new Set<string>();
  const slotIds = new Set(slots.map((slot) => slot.slot_id));
  for (const node of scenario.nodes) {
    if (!node.id || ids.has(node.id)) problems.push(`duplicate or empty node id: ${node.id}`);
    ids.add(node.id);
    for (const part of node.display_sequence ?? []) {
      if ("name_slot_id" in part && !slotIds.has(part.name_slot_id)) problems.push(`${node.id}: unknown display slot ${part.name_slot_id}`);
    }
    for (const part of node.audio?.sequence ?? []) {
      if ("name_slot_id" in part && !slotIds.has(part.name_slot_id)) problems.push(`${node.id}: unknown audio slot ${part.name_slot_id}`);
    }
  }
  if (!ids.has(scenario.entry_node)) problems.push(`missing entry node: ${scenario.entry_node}`);
  const requireTarget = (source: ScenarioNode, target: string) => {
    if (!ids.has(target)) problems.push(`${source.id}: unknown next node ${target}`);
  };
  for (const node of scenario.nodes) {
    if (node.type === "line" || node.type === "gate") requireTarget(node, node.next);
    if (node.type === "branch") {
      requireTarget(node, node.fallback);
      node.variants.forEach((variant) => requireTarget(node, variant.next));
    }
    if (node.type === "reaction_prompt") {
      const reaction = node.reaction_window;
      if (reaction.window_ms < 250 || reaction.window_ms > 60_000) problems.push(`${node.id}: invalid reaction window`);
      if (new Set(reaction.accepted_raw_inputs).size !== reaction.accepted_raw_inputs.length) problems.push(`${node.id}: duplicate accepted reaction input`);
      const threshold = reaction.detection?.minimum_confidence;
      if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) problems.push(`${node.id}: invalid minimum confidence`);
      if (reaction.safety?.important_branch && reaction.safety.confirmations_required !== 2) problems.push(`${node.id}: important branch requires two confirmations`);
      const reachable = new Set([...reaction.accepted_raw_inputs, reaction.timeout_input, "UNKNOWN" as const]);
      for (const input of reachable) {
        const action = reaction.context_mapping[input];
        if (!action) problems.push(`${node.id}: missing context mapping for ${input}`);
        else if (!reaction.branches[action]) problems.push(`${node.id}: missing branch for action ${action}`);
      }
      Object.values(reaction.branches).forEach((target) => requireTarget(node, target));
    }
  }
  if (problems.length) throw new ScenarioValidationError(problems);
}
