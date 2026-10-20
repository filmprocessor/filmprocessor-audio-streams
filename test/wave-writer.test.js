// A WAV written a section at a time: header sizes, the RIFF/RF64 switch at
// 4 GiB, and a round trip through the ranged reader the audio application opens
// masters with.
import assert from "node:assert/strict";
import test from "node:test";
import {
  StreamingWaveWriter,
  encodePcm,
  memorySink,
} from "../src/wave-writer.js";
import { openRangedAudioSource } from "../src/audio-source.js";

const tone = (channel, frame) => Math.sin((frame + 1) * (channel + 1) * 0.001) * 0.5;

function section(channels, from, frames) {
  return Array.from({ length: channels }, (_, ch) => {
    const plane = new Float32Array(frames);
    for (let f = 0; f < frames; f += 1) plane[f] = tone(ch, from + f);
    return plane;
  });
}

test("sections written in order read back as one file, 24-bit, masked", async () => {
  const sink = memorySink();
  const writer = new StreamingWaveWriter(sink, { sampleRate: 48000, channels: 6, bitDepth: 24, channelMask: 0x3f });
  await writer.begin();
  for (let from = 0; from < 30000; from += 7000) {
    const frames = Math.min(7000, 30000 - from);
    await writer.writeFrames(section(6, from, frames), frames);
  }
  const result = await writer.finish();
  assert.equal(result.frames, 30000);
  assert.equal(result.dataBytes, 30000 * 6 * 3);
  assert.equal(result.rf64, false);

  const bytes = sink.bytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "RIFF");
  assert.equal(view.getUint32(4, true), bytes.length - 8);

  const source = await openRangedAudioSource(new Blob([bytes]));
  assert.equal(source.channels, 6);
  assert.equal(source.frames, 30000);
  assert.equal(source.bitDepth, 24);
  assert.deepEqual(source.labels, ["L", "R", "C", "LFE", "Ls", "Rs"]);
  const planes = await source.read(12000, 50);
  for (let ch = 0; ch < 6; ch += 1) {
    for (let f = 0; f < 50; f += 1) {
      assert.ok(Math.abs(planes[ch][f] - tone(ch, 12000 + f)) <= 2 / 8388608);
    }
  }
});

test("past 4 GiB the file becomes RF64 with its sizes in ds64", async () => {
  // A sink that keeps only the header region, so the test writes sizes, not gigabytes.
  const header = new Uint8Array(256);
  const sink = {
    async write(data, position) {
      if (position < header.length) header.set(data.subarray(0, Math.max(0, header.length - position)), position);
    },
  };
  const writer = new StreamingWaveWriter(sink, { sampleRate: 48000, channels: 8, bitDepth: 24, channelMask: 0x63f });
  await writer.begin();
  // Account for 2 h 40 min of 8-channel 24-bit sound without allocating it.
  writer.frames = 48000 * 9600;
  writer.dataBytes = writer.frames * 8 * 3;
  writer.position = writer.headerLength + writer.dataBytes;
  const result = await writer.finish();
  assert.equal(result.rf64, true);
  const view = new DataView(header.buffer);
  assert.equal(String.fromCharCode(...header.subarray(0, 4)), "RF64");
  assert.equal(view.getUint32(4, true), 0xffffffff);
  assert.equal(String.fromCharCode(...header.subarray(12, 16)), "ds64");
  const dataSize = view.getUint32(28, true) + view.getUint32(32, true) * 0x100000000;
  assert.equal(dataSize, writer.dataBytes);
  const frames = view.getUint32(36, true) + view.getUint32(40, true) * 0x100000000;
  assert.equal(frames, 48000 * 9600);
  // The data chunk's own size field says "see ds64".
  assert.equal(view.getUint32(writer.dataSizeOffset, true), 0xffffffff);
});

test("integer output clips to full scale and scales as the whole-file writer does", () => {
  // bufferToWave in spatializer/index.inline-1.js: negative samples scale by
  // 2^23 and positive by 2^23 - 1, both floored, at 24 bits.
  const planes = [Float32Array.of(1.5, -1.5, 0.5, -0.5, 0.25, -1 / 8388608)];
  const bytes = encodePcm(planes, 6, 24);
  const read = (i) => {
    let v = bytes[i * 3] | (bytes[i * 3 + 1] << 8) | (bytes[i * 3 + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    return v;
  };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(read), [8388607, -8388608, 4194303, -4194304, 2097151, -1]);
  const sixteen = new DataView(encodePcm([Float32Array.of(0.5, -0.5)], 2, 16).buffer);
  assert.deepEqual([sixteen.getInt16(0, true), sixteen.getInt16(2, true)], [16384, -16384]);
});

test("a finished writer refuses more sound, and channel counts must hold", async () => {
  const writer = new StreamingWaveWriter(memorySink(), { sampleRate: 48000, channels: 2 });
  await writer.begin();
  await assert.rejects(writer.writeFrames(section(3, 0, 10)), /Channel count/);
  await writer.writeFrames(section(2, 0, 10));
  await writer.finish();
  await assert.rejects(writer.writeFrames(section(2, 10, 10)), /already finished/);
  assert.throws(() => new StreamingWaveWriter(memorySink(), { sampleRate: 48000, channels: 2, bitDepth: 20 }), /16, 24 or 32/);
});
