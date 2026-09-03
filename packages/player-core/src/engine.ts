import { applyEffects, evaluateAll } from "./evaluator";
import type { AudioPart, NameSlot, ReactionInput, ResolvedHistoryEntry, Resolvers, RuntimeSnapshot, Scenario, ScenarioNode, Variables } from "./types";
import { validateScenario } from "./validate";
import { normalizeReactionInput } from "./reaction-input";
import type { ReactionDetection, ReactionRuntimeOptions } from "./types";

const clone = <T>(value: T): T => structuredClone(value);

export class PlayerEngine {
  private readonly nodes: Map<string, ScenarioNode>;
  private snapshot: RuntimeSnapshot;
  private currentEntry: ResolvedHistoryEntry | null = null;
  private transitionCount = 0;

  constructor(
    private readonly scenario: Scenario,
    private readonly slots: NameSlot[],
    private readonly resolvers: Resolvers,
    initialVariables: Variables = {},
    restored?: RuntimeSnapshot,
    private readonly reactionOptions: ReactionRuntimeOptions = {}
  ) {
    validateScenario(scenario, slots);
    this.nodes = new Map(scenario.nodes.map((node) => [node.id, node]));
    this.snapshot = restored ? { ...clone(restored), pendingReactionConfirmation: restored.pendingReactionConfirmation } : {
      sessionId: crypto.randomUUID(), revision: 0, mode: "LIVE", status: "IDLE",
      currentNodeId: scenario.entry_node, variables: clone(initialVariables), history: [], historyIndex: null,
      pendingReaction: false
    };
  }

  get state(): RuntimeSnapshot { return clone(this.snapshot); }
  get node(): ScenarioNode { return this.requireNode(this.snapshot.currentNodeId); }

  start(): ResolvedHistoryEntry | null {
    if (this.snapshot.status === "ENDED") return null;
    this.snapshot.mode = "LIVE";
    this.snapshot.status = "PLAYING";
    return this.enterCurrent();
  }

  pause(): void {
    if (!["ENDED", "ERROR"].includes(this.snapshot.status)) this.snapshot.status = "PAUSED";
  }

  resume(): ResolvedHistoryEntry | null {
    if (this.snapshot.status !== "PAUSED") return this.currentEntry;
    this.snapshot.status = "PLAYING";
    return this.currentEntry ?? this.enterCurrent();
  }

  audioCompleted(): ResolvedHistoryEntry | null {
    if (this.snapshot.mode !== "LIVE" || this.snapshot.status === "PAUSED") return null;
    const node = this.node;
    if (node.type === "reaction_prompt") {
      this.snapshot.status = "WAITING_REACTION";
      this.snapshot.pendingReaction = true;
      return this.currentEntry;
    }
    if (node.type === "line" && node.advance === "user_next") {
      this.snapshot.status = "WAITING_NEXT";
      return this.currentEntry;
    }
    return this.commitAndAdvance();
  }

  next(): ResolvedHistoryEntry | null {
    if (this.snapshot.status === "WAITING_REACTION") return this.react("NEXT");
    if (this.snapshot.status !== "WAITING_NEXT") return null;
    return this.commitAndAdvance();
  }

  react(input: ReactionInput | ReactionDetection): ResolvedHistoryEntry | null {
    const node = this.node;
    if (node.type !== "reaction_prompt" || !this.snapshot.pendingReaction || this.snapshot.status !== "WAITING_REACTION") return null;
    const normalized = normalizeReactionInput(input, node.reaction_window, this.reactionOptions);
    const safeInput = normalized.input;
    const confirmations = node.reaction_window.safety?.confirmations_required ?? 1;
    if (confirmations === 2 && safeInput !== "SILENT" && safeInput !== "UNKNOWN" && safeInput !== "NEXT") {
      const pending = this.snapshot.pendingReactionConfirmation;
      if (!pending) {
        this.snapshot.pendingReactionConfirmation = { input: safeInput, count: 1 };
        return this.currentEntry ? clone(this.currentEntry) : null;
      }
      if (pending.input !== safeInput) {
        this.snapshot.pendingReactionConfirmation = undefined;
        return this.resolveReaction(node, "UNKNOWN", normalized);
      }
    }
    this.snapshot.pendingReactionConfirmation = undefined;
    return this.resolveReaction(node, safeInput, normalized);
  }

  private resolveReaction(node: Extract<ScenarioNode, { type: "reaction_prompt" }>, safeInput: ReactionInput, detection: ReturnType<typeof normalizeReactionInput>): ResolvedHistoryEntry | null {
    this.snapshot.pendingReaction = false;
    const action = node.reaction_window.context_mapping[safeInput] ?? node.reaction_window.context_mapping.UNKNOWN;
    const target = action ? node.reaction_window.branches[action] : undefined;
    if (!action || !target) return this.fail("Reaction mapping is incomplete");
    if (this.currentEntry) {
      this.currentEntry.reactionInput = safeInput;
      this.currentEntry.rawReactionInput = detection.rawInput;
      this.currentEntry.reactionMethod = detection.method;
      this.currentEntry.reactionConfidence = detection.confidence;
      this.currentEntry.contextAction = action;
      this.currentEntry.nextNodeId = target;
    }
    return this.commitAndAdvance(target);
  }

  reactionTimedOut(): ResolvedHistoryEntry | null {
    const node = this.node;
    return node.type === "reaction_prompt" ? this.react({ input: node.reaction_window.timeout_input, method: "TIMEOUT", confidence: 1 }) : null;
  }

  seekHistory(index: number): ResolvedHistoryEntry | null {
    if (index < 0 || index >= this.snapshot.history.length) return null;
    this.snapshot.mode = "HISTORY";
    this.snapshot.historyIndex = index;
    this.snapshot.status = "PAUSED";
    return clone(this.snapshot.history[index]);
  }

  returnToLive(): ResolvedHistoryEntry | null {
    this.snapshot.mode = "LIVE";
    this.snapshot.historyIndex = null;
    this.snapshot.status = this.currentEntry ? "PLAYING" : this.snapshot.status;
    return this.currentEntry ? clone(this.currentEntry) : null;
  }

  private enterCurrent(): ResolvedHistoryEntry | null {
    this.transitionCount += 1;
    if (this.transitionCount > 10_000) return this.fail("Runtime loop guard reached");
    const node = this.node;
    if (node.type === "branch") {
      const selected = node.variants.find((variant) => evaluateAll(variant.conditions, this.snapshot.variables));
      return this.advanceWithoutHistory(selected?.next ?? node.fallback);
    }
    if (node.type === "gate") return this.advanceWithoutHistory(node.next);
    if (node.type === "end") {
      this.snapshot.status = "ENDED";
      this.currentEntry = this.makeEntry(node);
      this.snapshot.history.push(clone(this.currentEntry));
      this.snapshot.revision += 1;
      return clone(this.currentEntry);
    }
    this.currentEntry = this.makeEntry(node);
    this.snapshot.status = "PLAYING";
    return clone(this.currentEntry);
  }

  private commitAndAdvance(forcedTarget?: string): ResolvedHistoryEntry | null {
    const node = this.node;
    if (!this.currentEntry) return this.fail("No active node to commit");
    this.snapshot.variables = applyEffects(this.snapshot.variables, node.effects);
    if (!this.currentEntry.nextNodeId) this.currentEntry.nextNodeId = forcedTarget ?? (node.type === "line" ? node.next : undefined);
    this.snapshot.history.push(clone(this.currentEntry));
    this.snapshot.revision += 1;
    const target = forcedTarget ?? (node.type === "line" ? node.next : undefined);
    this.currentEntry = null;
    if (!target) return this.fail("Node has no transition target");
    this.snapshot.currentNodeId = target;
    return this.enterCurrent();
  }

  private advanceWithoutHistory(target: string): ResolvedHistoryEntry | null {
    this.snapshot.currentNodeId = target;
    return this.enterCurrent();
  }

  private makeEntry(node: ScenarioNode): ResolvedHistoryEntry {
    const displayText = (node.display_sequence ?? []).map((part) => {
      if ("text" in part) return part.text;
      if ("name_slot_id" in part) return this.resolvers.displayName(part.name_slot_id);
      return "";
    }).join("");
    const displayImages = (node.display_sequence ?? []).filter((part): part is Extract<typeof part, { image_asset_id: string }> => "image_asset_id" in part);
    const audioSequence = (node.audio?.sequence ?? []).flatMap<AudioPart>((part) => "name_slot_id" in part ? this.resolvers.resolveNameAudio(part.name_slot_id) : [part]);
    return {
      index: this.snapshot.history.length, nodeId: node.id, speaker: node.speaker, timelineMs: node.timeline_ms,
      displayText, displayImages: displayImages.length ? displayImages : undefined,
      audioSequence, committedAt: new Date().toISOString()
    };
  }

  private requireNode(id: string): ScenarioNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown node: ${id}`);
    return node;
  }

  private fail(message: string): null {
    this.snapshot.status = "ERROR";
    throw new Error(message);
  }
}
