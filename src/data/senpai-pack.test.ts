import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlayerEngine, validateScenario } from "@pne/player-core";
import { SENPAI_WORK } from "./senpai-pack";

describe("senpai State Kit migration", () => {
  it("produces a valid Tauri scenario with all bundled audio clips", () => {
    expect(() => validateScenario(SENPAI_WORK.scenario, SENPAI_WORK.nameSlots)).not.toThrow();
    expect(SENPAI_WORK.scenario.nodes).toHaveLength(47);
    expect(SENPAI_WORK.scenario.nodes.filter((node) => node.type === "reaction_prompt")).toHaveLength(7);
    const engine = new PlayerEngine(SENPAI_WORK.scenario, SENPAI_WORK.nameSlots, { displayName: () => "まちこ", resolveNameAudio: () => [] });
    expect(engine.start()?.displayText).toBe("……まちこ先輩、で合ってます？");
    for (const node of SENPAI_WORK.scenario.nodes) {
      for (const part of node.audio?.sequence ?? []) {
        if (!("clip_id" in part) || !part.clip_id.startsWith("/senpai-audio/")) continue;
        expect(existsSync(join(process.cwd(), "img", part.clip_id.slice(1)))).toBe(true);
      }
    }
  });

  it("preserves forced-interpretation raw-input branches", () => {
    const prompt = SENPAI_WORK.scenario.nodes.find((node) => node.id === "FI1_PROMPT");
    if (prompt?.type !== "reaction_prompt") throw new Error("FI1_PROMPT is missing");
    const silentAction = prompt.reaction_window.context_mapping.SILENT;
    const unknownAction = prompt.reaction_window.context_mapping.UNKNOWN;
    expect(silentAction).toBe("NO_RESPONSE");
    expect(unknownAction).toBe("NO_CLEAR_RESPONSE");
    expect(prompt.reaction_window.branches[silentAction!]).toBe("FI1_SILENT");
    expect(prompt.reaction_window.branches[unknownAction!]).toBe("FI1_UNKNOWN");
  });

  it("reaches the central payoff through timeout-compatible silence", () => {
    const engine = new PlayerEngine(SENPAI_WORK.scenario, SENPAI_WORK.nameSlots, {
      displayName: () => "まちこ",
      resolveNameAudio: () => [{ gap_ms: 1 }]
    });
    engine.start();
    for (let guard = 0; guard < 100 && engine.state.status !== "ENDED"; guard += 1) {
      if (engine.state.status === "PLAYING") engine.audioCompleted();
      else if (engine.state.status === "WAITING_REACTION") engine.react("SILENT");
      else throw new Error(`unexpected status: ${engine.state.status}`);
    }
    expect(engine.state.status).toBe("ENDED");
    expect(engine.state.history.some((entry) => entry.nodeId === "FI1_SILENT")).toBe(true);
    expect(engine.state.history.some((entry) => entry.nodeId === "END_01")).toBe(true);
  });
});
