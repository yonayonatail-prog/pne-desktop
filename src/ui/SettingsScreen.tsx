import { useState } from "react";
import { PageHeader } from "./shared";
import { MicrophoneTester } from "./MicrophoneTester";

export function SettingsScreen() {
  const [volume, setVolume] = useState(Number(localStorage.getItem("pne.volume") ?? 82));
  const [motion, setMotion] = useState(localStorage.getItem("pne.reducedMotion") === "1");
  const [publicSpace, setPublicSpace] = useState(localStorage.getItem("pne.publicSpaceMode") === "1");
  const [detailedReaction, setDetailedReaction] = useState(localStorage.getItem("pne.detailedReactionInput") !== "0");
  const [clickInput, setClickInput] = useState(localStorage.getItem("pne.clickInput") === "1");
  return <div className="page settings-page"><PageHeader eyebrow="PREFERENCES" title="設定" />
    <section className="settings-section"><h2>再生</h2><div className="setting-row"><div><b>マスター音量</b><small>VOICE・BGM・SEの全体音量</small></div><div className="range-control"><input type="range" min="0" max="100" value={volume} onChange={(event) => { const value = Number(event.target.value); setVolume(value); localStorage.setItem("pne.volume", String(value)); }} /><output>{volume}%</output></div></div><label className="setting-row"><div><b>動きを減らす</b><small>光や画面遷移のアニメーションを抑えます</small></div><input className="switch" type="checkbox" checked={motion} onChange={(event) => { setMotion(event.target.checked); localStorage.setItem("pne.reducedMotion", event.target.checked ? "1" : "0"); }} /></label></section>
    <section className="settings-section"><h2>Reaction入力（実験機能）</h2><label className="setting-row"><div><b>詳細な肯定・否定判定</b><small>VOICE_YES / VOICE_NOを利用し、非対応作品ではVOICEへ安全に縮約します</small></div><input className="switch" type="checkbox" checked={detailedReaction} onChange={(event) => { setDetailedReaction(event.target.checked); localStorage.setItem("pne.detailedReactionInput", event.target.checked ? "1" : "0"); }} /></label><label className="setting-row"><div><b>歯カチ入力</b><small>端末マイクなどで歯をカチッと鳴らしてReactionに反応します</small></div><input className="switch" type="checkbox" checked={clickInput} onChange={(event) => { setClickInput(event.target.checked); localStorage.setItem("pne.clickInput", event.target.checked ? "1" : "0"); }} /></label>{clickInput && <><MicrophoneTester compact /><section className="notice-panel warning reaction-click-notice"><b>骨伝導イヤホンについて</b><p>骨伝導イヤホンを装着しただけではクリック入力を検出できません。端末マイク、顎周辺の接触型マイク、または対応デバイスが必要です。</p></section></>}<label className="setting-row"><div><b>ボタンで操作</b><small>声を使わず、歯カチ・反応しない・次へをボタンで選びます</small></div><input className="switch" type="checkbox" checked={publicSpace} onChange={(event) => { setPublicSpace(event.target.checked); localStorage.setItem("pne.publicSpaceMode", event.target.checked ? "1" : "0"); }} /></label></section>
    <section className="settings-section"><h2>プライバシーと保存</h2><div className="setting-row"><div><b>保存された名前プロフィール</b><small>この開発buildではプロフィール候補を永続保存していません</small></div><button className="button secondary" disabled>管理</button></div><div className="setting-row"><div><b>生成した名前音声</b><small>正式モデル統合後、作品・プロフィール別に削除できます</small></div><button className="button secondary" disabled>キャッシュを管理</button></div></section>
    <section className="notice-panel"><b>このPC内だけで処理</b><p>名前・読み・生成音声・Reaction判定をP.N.E.のサーバーまたは第三者サービスへ送信しません。Reaction履歴には判定種別・方式・信頼度だけを保存し、録音データや発話内容は保存しません。</p></section>
  </div>;
}
