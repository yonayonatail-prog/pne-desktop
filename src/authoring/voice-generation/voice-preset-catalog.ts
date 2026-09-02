import type { VoicePreset } from "../types";

// The catalog is deliberately small and editable. Projects can point a
// preset at their own reference audio without changing the preset identity.
export const DEFAULT_VOICE_PRESETS: VoicePreset[] = [
  {
    voice_preset_id: "preset_hiiro_f01",
    label: "ひいろ・標準",
    group: "女性",
    tags: ["やさしい", "近距離", "標準"],
    mode: "reference",
    model_id: "irodori-tts-500m-v3-fp16",
    preview_audio: "/voice-reference/hiiro.ogg",
    reference_audio: "/voice-reference/hiiro.ogg",
    reference_version: "hiiro-n1-02-ogg-v1"
  },
  {
    voice_preset_id: "preset_highschool_m01",
    label: "高校生男子・自然",
    group: "男性",
    tags: ["自然", "近距離", "標準"],
    mode: "reference",
    model_id: "irodori-tts-500m-v3-fp16",
    preview_audio: "/voice-reference/高校生男子.mp3",
    reference_audio: "/voice-reference/高校生男子.mp3",
    reference_version: "highschool-male-n1-mp3-v1"
  },
  {
    voice_preset_id: "preset_highschool_m02",
    label: "高校生男子・低め",
    group: "男性",
    tags: ["低め", "落ち着き", "標準"],
    mode: "reference",
    model_id: "irodori-tts-500m-v3-fp16",
    preview_audio: "/voice-reference/高校生男子２.mp3",
    reference_audio: "/voice-reference/高校生男子２.mp3",
    reference_version: "highschool-male-low-n1-mp3-v1"
  }
];

export function findVoicePreset(presetId: string | undefined, presets = DEFAULT_VOICE_PRESETS): VoicePreset | undefined {
  return presets.find((preset) => preset.voice_preset_id === presetId) || presets[0];
}
