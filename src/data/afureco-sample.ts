import type { AfurecoProject } from "../afureco/types";

export const SAMPLE_AFURECO_PROJECT: AfurecoProject = {
  projectId: "afureco-rain-room-dev",
  projectName: "雨の部屋・アフレコ案件",
  workTitle: "雨の部屋",
  scriptVersion: "script-v1.0.0",
  assignedCharacter: "ヒイロ",
  actorName: "ゲスト声優（ローカル検証）",
  state: "RECORDING",
  lines: [
    {
      lineId: "rain-room.line.start",
      nodeId: "START",
      sceneId: "scene-01",
      sceneName: "雨音の部屋",
      characterId: "hiiro",
      speakerName: "？？？",
      text: "……聞こえる？　あなた。",
      direction: "雨音の向こうから、相手の反応を確かめるように。",
      expectedDurationMs: 2400,
      status: "NOT_RECORDED"
    },
    {
      lineId: "rain-room.line.rain",
      nodeId: "RAIN",
      sceneId: "scene-01",
      sceneName: "雨音の部屋",
      characterId: "hiiro",
      speakerName: "ヒイロ",
      text: "よかった。雨が強くて、もう誰にも届かないかと思った。",
      direction: "安堵をにじませる。少し距離の近い声。",
      expectedDurationMs: 4200,
      status: "NOT_RECORDED"
    },
    {
      lineId: "rain-room.line.ask",
      nodeId: "ASK",
      sceneId: "scene-01",
      sceneName: "雨音の部屋",
      characterId: "hiiro",
      speakerName: "ヒイロ",
      text: "ねえ。そこにいるなら、声を聞かせて。",
      direction: "返事を待つ。語尾に小さな期待を残す。",
      expectedDurationMs: 3000,
      status: "NOT_RECORDED"
    },
    {
      lineId: "rain-room.line.answer",
      nodeId: "ANSWER",
      sceneId: "scene-02",
      sceneName: "返事のあと",
      characterId: "hiiro",
      speakerName: "ヒイロ",
      text: "……うん。ちゃんと聞こえた。これでもう、ひとりじゃない。",
      direction: "声を受け取れた喜びを抑えめに。",
      expectedDurationMs: 4200,
      status: "NOT_RECORDED"
    },
    {
      lineId: "rain-room.line.silence",
      nodeId: "SILENCE",
      sceneId: "scene-02",
      sceneName: "返事のあと",
      characterId: "hiiro",
      speakerName: "ヒイロ",
      text: "黙っただけなのに。なぜか、そこにいるって分かるよ。",
      direction: "沈黙を責めず、静かに受け止める。",
      expectedDurationMs: 4000,
      status: "NOT_RECORDED"
    },
    {
      lineId: "rain-room.line.end",
      nodeId: "END",
      sceneId: "scene-03",
      sceneName: "雨が遠ざかる",
      characterId: "hiiro",
      speakerName: "ヒイロ",
      text: "雨音は、少しだけ遠ざかった。",
      direction: "エンディング。余韻を長めに残す。",
      expectedDurationMs: 2600,
      status: "NOT_RECORDED"
    }
  ]
};

export const SAMPLE_AFURECO_PROJECTS = [SAMPLE_AFURECO_PROJECT];
