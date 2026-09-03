import type { AuthoringPack } from "./types";

export const SAMPLE_AUTHORING_PACK: AuthoringPack = {
  format: "pne_statekit_pack",
  schema_version: "1.0.0",
  meta: { title: "雨の部屋", version: "1.0.0-dev", author: "P.N.E. Studio", description: "雨音の向こうから届く声に、あなたの反応が物語の記憶として残る短編。" },
  entry_node: "START",
  characters: [
    { character_id: "char_hiiro", name: "ヒイロ", color: "pink", voice_preset_id: "preset_hiiro_f01", first_person: "私", profile: { role: "雨の向こうから話しかける人", public_face: "静かでやさしい", hidden_truth: "返事の有無を大切な記憶として受け取る", desire: "ひとりではないと確かめたい", fear: "声が届かないこと", relationship_axis: "あなたを待つ側から、隣にいる側へ" } },
    { character_id: "char_narrator", name: "？？？", color: "gold", profile: { role: "耳で物語を運ぶ声", public_face: "簡潔で明瞭", hidden_truth: "入力を意味ではなく出来事として記録する", notes: "UI案内は短く直接的にする" } }
  ],
  character_timelines: [
    { character_id: "char_hiiro", beats: [
      { phase: "past", label: "雨の前", key_event: "誰にも届かない場所で待ち続ける", inner_state: "届くことをあきらめかけている" },
      { phase: "present_start", label: "呼びかけ", key_event: "雨音の向こうへ声を投げる", inner_state: "返事がなくても話し続ける" },
      { phase: "mid", label: "反応の記憶", key_event: "声と沈黙のどちらも受け取る", inner_state: "相手の存在を疑わなくなる" },
      { phase: "end", label: "雨が遠ざかる", key_event: "ひとりではないという感覚を残す", inner_state: "待つ側から隣にいる側へ" }
    ] },
    { character_id: "char_narrator", beats: [
      { phase: "present_start", label: "導入", key_event: "入力方法を短く案内する", inner_state: "物語への入口を作る" },
      { phase: "mid", label: "解釈", key_event: "VOICEとSILENTを異なる出来事として描く", inner_state: "入力そのものに固定意味を与えない" },
      { phase: "end", label: "余韻", key_event: "反応しなくても終点へ運ぶ", inner_state: "作品としての完走を保証する" }
    ] }
  ],
  experience_routes: [{ route_id: "route_main", kind: "main", label: "雨の部屋・主線", entry_unit_id: "unit_intro" }],
  experience_timeline: [
    { unit_id: "unit_intro", route_id: "route_main", order: 10, unit: "導入", viewer_state_start: "雨音の向こうに誰かがいる", viewer_state_end: "声が届く場所にいる", inversion: "不在 → 接続", emotional_peak: "最初の呼びかけ", complicity_trigger: "返事をするか、黙って聞くか", linked: [] },
    { unit_id: "unit_reaction", route_id: "route_main", order: 20, unit: "反応の窓", viewer_state_start: "返事を求められている", viewer_state_end: "どんな反応も記憶された", inversion: "正解探し → 自分のペース", emotional_peak: "沈黙にも返事が返る", complicity_trigger: "入力しないことも体験になる", linked: [] },
    { unit_id: "unit_after", route_id: "route_main", order: 30, unit: "余韻", viewer_state_start: "ひとりかもしれない", viewer_state_end: "ひとりではない", inversion: "距離 → 隣", emotional_peak: "雨音が遠ざかる", complicity_trigger: "聞き届けたという感覚", linked: [] }
  ],
  experience_links: [
    { link_id: "link_intro_reaction", from_unit_id: "unit_intro", to_unit_id: "unit_reaction", type: "main" },
    { link_id: "link_reaction_after", from_unit_id: "unit_reaction", to_unit_id: "unit_after", type: "main", label: "どの反応も余韻へ" }
  ],
  mislead_foreshadow_registry: [],
  state_schema: { variables: [{ key: "visits", type: "integer", initial: 0, min: 0, max: 10 }, { key: "heard", type: "integer", initial: 0, min: 0, max: 1 }], flags: [] },
  pne_rules: { input_types: ["VOICE", "SILENT", "UNKNOWN"], unknown_behavior: "progress", reaction_loop_max_turns: 1 },
  runtime_state: { visits: 0, heard: 0, memory: {} },
  nodes: [
    { id: "START", source_unit_id: "unit_intro", chapter: "導入", type: "start", speaker: "？？？", text: "……聞こえる？　雨が強くて、もう誰にも届かないかと思った。", next: "ASK", performance: { tone: "quiet", pace: "slow" } },
    { id: "ASK", source_unit_id: "unit_reaction", chapter: "反応の窓", type: "reaction", speaker: "ヒイロ", text: "ねえ。そこにいるなら、短く返事を聞かせて。", reaction_window: { window_ms: 6000, accepted_raw_inputs: ["VOICE", "SILENT", "UNKNOWN"], branches: { VOICE: "ANSWER", SILENT: "SILENCE", UNKNOWN: "SILENCE" } }, performance: { tone: "clear", pace: "slow" } },
    { id: "ANSWER", source_unit_id: "unit_reaction", chapter: "反応の窓", type: "branch", speaker: "ヒイロ", text: "……うん。ちゃんと聞こえた。これでもう、ひとりじゃない。", next: "END", state_updates: { heard: 1 }, memory_updates: { last_input: "VOICE" } },
    { id: "SILENCE", source_unit_id: "unit_reaction", chapter: "反応の窓", type: "branch", speaker: "ヒイロ", text: "黙っただけなのに。なぜか、そこにいるって分かるよ。", next: "END", state_updates: { heard: 0 }, memory_updates: { last_input: "SILENT" } },
    { id: "END", source_unit_id: "unit_after", chapter: "余韻", type: "end", speaker: "？？？", text: "雨音は、少しだけ遠ざかった。" }
  ]
};
