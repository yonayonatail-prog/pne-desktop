import { describe, expect, it } from "vitest";
import { audioBufferToWav } from "./voice-recorder";

describe("audioBufferToWav", () => {
  it("writes mono 48 kHz 24-bit PCM WAV headers", async () => {
    const source = new Float32Array([0, -1, 1]);
    const buffer = { duration: 1, getChannelData: () => source } as unknown as AudioBuffer;
    const wav = audioBufferToWav(buffer, 3);
    const bytes = new Uint8Array(await wav.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(wav.type).toBe("audio/wav");
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(3);
    expect(view.getUint16(32, true)).toBe(3);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(9);
    expect(bytes.length).toBe(53);
  });
});
