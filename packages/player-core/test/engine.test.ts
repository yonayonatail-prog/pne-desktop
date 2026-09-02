import { describe, expect, it } from "vitest";
import { PlayerEngine, ScenarioValidationError, applyEffects, canDetectClicks, evaluateCondition, normalizeReactionInput, preferredDetectionMethod, toLegacyReactionInput, validateScenario, type NameSlot, type Scenario } from "../src";

const slots: NameSlot[] = [{ slot_id: "name.main", fallback_clip_id: "voice.fallback", fallback_text: "あなた" }];
const scenario: Scenario = {
  schema_version: "1.0", entry_node: "START", nodes: [
    { id: "START", type: "line", timeline_ms: 0, speaker: "ナレーター", display_sequence: [{ text: "ようこそ、" }, { name_slot_id: "name.main" }], audio: { sequence: [] }, effects: [{ variable: "visits", operation: "increment" }], advance: "auto", next: "ASK" },
    { id: "ASK", type: "reaction_prompt", timeline_ms: 1000, display_sequence: [{ text: "返事をして" }], audio: { sequence: [] }, reaction_window: { window_ms: 4000, accepted_raw_inputs: ["VOICE", "SILENT", "NEXT"], timeout_input: "SILENT", context_mapping: { VOICE: "YES", SILENT: "NO", NEXT: "YES", UNKNOWN: "NO" }, branches: { YES: "GOOD", NO: "QUIET" } } },
    { id: "GOOD", type: "line", timeline_ms: 2000, display_sequence: [{ text: "聞こえたよ" }], audio: { sequence: [] }, advance: "auto", next: "END" },
    { id: "QUIET", type: "line", timeline_ms: 2000, display_sequence: [{ text: "静かだね" }], audio: { sequence: [] }, advance: "auto", next: "END" },
    { id: "END", type: "end", timeline_ms: 3000, display_sequence: [{ text: "おしまい" }] }
  ]
};

const makeEngine = () => new PlayerEngine(scenario, slots, { displayName: () => "みなと先輩", resolveNameAudio: () => [] }, { visits: 0 });

describe("PlayerEngine", () => {
  it("commits effects once and resolves a reaction once", () => {
    const engine = makeEngine();
    expect(engine.start()?.displayText).toBe("ようこそ、みなと先輩");
    expect(engine.audioCompleted()?.nodeId).toBe("ASK");
    engine.audioCompleted();
    expect(engine.react("VOICE")?.nodeId).toBe("GOOD");
    expect(engine.react("SILENT")).toBeNull();
    expect(engine.state.variables.visits).toBe(1);
    expect(engine.state.history).toHaveLength(2);
  });

  it("history seek never mutates live variables", () => {
    const engine = makeEngine();
    engine.start(); engine.audioCompleted(); engine.audioCompleted(); engine.react("SILENT");
    const before = engine.state.variables;
    expect(engine.seekHistory(0)?.nodeId).toBe("START");
    expect(engine.state.mode).toBe("HISTORY");
    expect(engine.state.variables).toEqual(before);
    engine.returnToLive();
    expect(engine.state.mode).toBe("LIVE");
  });
});

describe("runtime helpers", () => {
  it("evaluates conditions and applies immutable effects", () => {
    const source = { score: 2, flag: false };
    expect(evaluateCondition({ variable: "score", operator: "gte", value: 2 }, source)).toBe(true);
    const changed = applyEffects(source, [{ variable: "score", operation: "increment", value: 3 }, { variable: "flag", operation: "toggle" }]);
    expect(changed).toEqual({ score: 5, flag: true });
    expect(source).toEqual({ score: 2, flag: false });
  });

  it("keeps detailed reactions compatible with legacy reaction windows", () => {
    const node = scenario.nodes.find((item) => item.id === "ASK");
    if (node?.type !== "reaction_prompt") throw new Error("fixture is missing ASK");
    expect(toLegacyReactionInput("VOICE_YES")).toBe("VOICE");
    expect(toLegacyReactionInput("CLICK_DOUBLE")).toBe("VOICE");
    expect(normalizeReactionInput({ input: "VOICE_NO", method: "KWS", confidence: 0.95 }, node.reaction_window).input).toBe("VOICE");
  });

  it("uses KWS for fixed words, DTW for templates, and does not mistake headphones for a click sensor", () => {
    expect(preferredDetectionMethod("FIXED_KEYWORD")).toBe("KWS");
    expect(preferredDetectionMethod("USER_TEMPLATE")).toBe("DTW");
    expect(canDetectClicks({ boneConductionHeadphones: true })).toBe(false);
    expect(canDetectClicks({ boneConductionHeadphones: true, contactMicrophone: true })).toBe(true);
  });

  it("blocks speech in public-space mode and rejects low-confidence detail", () => {
    const node = scenario.nodes.find((item) => item.id === "ASK");
    if (node?.type !== "reaction_prompt") throw new Error("fixture is missing ASK");
    expect(normalizeReactionInput({ input: "VOICE_YES", method: "KWS", confidence: 0.99 }, node.reaction_window, { inputMode: "PUBLIC_SPACE" }).input).toBe("UNKNOWN");
    expect(normalizeReactionInput({ input: "VOICE_YES", method: "KWS", confidence: 0.4 }, node.reaction_window, { minimumConfidence: 0.7 }).input).toBe("UNKNOWN");
  });

  it("requires matching confirmation twice for an important reaction", () => {
    const confirmed = structuredClone(scenario);
    const ask = confirmed.nodes.find((item) => item.id === "ASK");
    if (ask?.type !== "reaction_prompt") throw new Error("fixture is missing ASK");
    ask.reaction_window.accepted_raw_inputs = ["VOICE_YES", "VOICE_NO", "SILENT"];
    ask.reaction_window.context_mapping = { VOICE_YES: "YES", VOICE_NO: "NO", SILENT: "NO", UNKNOWN: "NO" };
    ask.reaction_window.safety = { important_branch: true, confirmations_required: 2 };
    const engine = new PlayerEngine(confirmed, slots, { displayName: () => "みなと先輩", resolveNameAudio: () => [] });
    engine.start(); engine.audioCompleted(); engine.audioCompleted();
    expect(engine.react({ input: "VOICE_YES", method: "KWS", confidence: 0.9 })?.nodeId).toBe("ASK");
    expect(engine.state.pendingReactionConfirmation).toEqual({ input: "VOICE_YES", count: 1 });
    expect(engine.react({ input: "VOICE_YES", method: "KWS", confidence: 0.92 })?.nodeId).toBe("GOOD");
    expect(engine.state.history.at(-1)?.reactionInput).toBe("VOICE_YES");
  });

  it("rejects dangling references", () => {
    const broken = structuredClone(scenario);
    (broken.nodes[0] as { next: string }).next = "MISSING";
    expect(() => validateScenario(broken, slots)).toThrow(ScenarioValidationError);
  });
});
