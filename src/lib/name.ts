import type { NameProfile } from "../types";

const suffix: Record<NameProfile["form"], string> = { bare: "", san: "さん", kun: "くん", chan: "ちゃん", senpai: "先輩" };

export function validateProfile(profile: NameProfile): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = profile.displayName.normalize("NFC").trim();
  const reading = profile.reading.normalize("NFC").trim();
  if (!name || [...name].length > 32) errors.displayName = "1〜32文字で入力してください";
  if (!reading || [...reading].length > 64 || !/^[ぁ-ゖァ-ヺー・\s]+$/.test(reading)) errors.reading = "ひらがな／カタカナで入力してください";
  return errors;
}

export function callDisplay(profile: NameProfile, form: NameProfile["form"] = profile.form): string {
  return `${profile.displayName.normalize("NFC").trim()}${suffix[form]}`;
}

export function callReading(profile: NameProfile, form: NameProfile["form"] = profile.form): string {
  return `${profile.reading.normalize("NFC").trim()}${suffix[form]}`;
}

export function speakLocally(profile: NameProfile): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!("speechSynthesis" in window)) { reject(new Error("ローカル音声合成を利用できません")); return; }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(callReading(profile));
    utterance.lang = "ja-JP";
    utterance.rate = 0.86;
    utterance.pitch = 0.94;
    utterance.onend = () => resolve();
    utterance.onerror = () => reject(new Error("試聴に失敗しました"));
    speechSynthesis.speak(utterance);
  });
}
