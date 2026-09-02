import type { LocalWork } from "../types";
import { SENPAI_WORK } from "./senpai-pack";

export const SAMPLE_WORK: LocalWork = {
  workId: "rain_room",
  version: "1.0.0-dev",
  title: "雨の部屋",
  author: "P.N.E. Studio",
  description: "雨音の向こうから呼びかける声に、あなたの反応で物語が静かに分岐していく短編です。",
  cover: "/chara_01.PNG",
  durationLabel: "約3分",
  durationMs: 40_000,
  sizeLabel: "開発fixture",
  state: "READY",
  capabilities: { web_playable: true, desktop_playable: true, name_call_supported: true, mobile_transfer_supported: true },
  nameSlots: [{ slot_id: "name.start.whisper", voice_id: "hiiro", form: "profile", fallback_clip_id: "voice.start.no_name", fallback_text: "あなた", post_gap_ms: 40, crossfade_ms: 5 }],
  nameVoice: {
    preview_slot_id: "name.start.whisper",
    voice_profiles: { hiiro: { reference: "/voice-reference/hiiro.ogg", reference_version: "hiiro-n1-02-ogg-v1", enabled: true } }
  },
  scenario: {
    schema_version: "1.0",
    entry_node: "START",
    nodes: [
      {
        id: "START", type: "line", timeline_ms: 0, speaker: "？？？",
        display_sequence: [{ text: "……聞こえる？　" }, { name_slot_id: "name.start.whisper" }, { text: "。" }],
        audio: { sequence: [{ gap_ms: 350 }, { name_slot_id: "name.start.whisper" }] },
        effects: [{ variable: "visits", operation: "increment", value: 1 }], advance: "auto", next: "RAIN"
      },
      {
        id: "RAIN", type: "line", timeline_ms: 6000, speaker: "ヒイロ",
        display_sequence: [{ text: "よかった。雨が強くて、もう誰にも届かないかと思った。" }],
        audio: { sequence: [{ gap_ms: 900 }] }, advance: "user_next", next: "ASK"
      },
      {
        id: "ASK", type: "reaction_prompt", timeline_ms: 16000, speaker: "ヒイロ",
        display_sequence: [{ text: "ねえ。そこにいるなら、声を聞かせて。" }],
        audio: { sequence: [{ gap_ms: 1200 }] },
        reaction_window: {
          window_ms: 6000, accepted_raw_inputs: ["VOICE", "VOICE_YES", "VOICE_NO", "VOICE_OTHER", "CLICK_SINGLE", "CLICK_DOUBLE", "SILENT", "NEXT"], timeout_input: "SILENT",
          context_mapping: { VOICE: "ANSWERED", VOICE_YES: "ANSWERED", VOICE_NO: "WAITED", VOICE_OTHER: "ANSWERED", CLICK_SINGLE: "ANSWERED", CLICK_DOUBLE: "WAITED", SILENT: "WAITED", NEXT: "ANSWERED", UNKNOWN: "WAITED" },
          detection: { detailed_inputs: true, minimum_confidence: 0.7 },
          branches: { ANSWERED: "ANSWER", WAITED: "SILENCE" }
        }
      },
      {
        id: "ANSWER", type: "line", timeline_ms: 26000, speaker: "ヒイロ",
        display_sequence: [{ text: "……うん。ちゃんと聞こえた。これでもう、ひとりじゃない。" }],
        audio: { sequence: [{ gap_ms: 1100 }] }, effects: [{ variable: "heard", operation: "set", value: true }], advance: "auto", next: "END"
      },
      {
        id: "SILENCE", type: "line", timeline_ms: 26000, speaker: "ヒイロ",
        display_sequence: [{ text: "黙っただけなのに。なぜか、そこにいるって分かるよ。" }],
        audio: { sequence: [{ gap_ms: 1100 }] }, effects: [{ variable: "heard", operation: "set", value: false }], advance: "auto", next: "END"
      },
      {
        id: "END", type: "end", timeline_ms: 40000, speaker: "",
        display_sequence: [{ text: "雨音は、少しだけ遠ざかった。" }]
      }
    ]
  }
};

export const SAMPLE_WORKS: LocalWork[] = [SAMPLE_WORK, SENPAI_WORK];
