// The master's sound, read a section at a time: synthetic WAV, RF64 and
// QuickTime files built here byte by byte, read through a File and through a
// fake HTTP server that serves byte ranges and counts what it sent.
import assert from "node:assert/strict";
import test from "node:test";
import {
  RangedAudioSourceError,
  decodeInterleavedPcm,
  labelsFromWaveChannelMask,
  openRangedAudioSource,
} from "../src/audio-source.js";
import {
  valueAt,
  pcmBytes,
  concat,
  u32,
  u16,
  ascii,
  box,
  waveFile,
  quickTimeMovie,
  qtV0,
  qtV2Lpcm,
  isoIpcm,
  asFile,
} from "./helpers/media-fixtures.js";

function assertFrames(planes, { firstFrame, channels, channelOffset = 0, frames, tolerance = 1e-6 }) {
  assert.equal(planes.length, channels);
  for (let ch = 0; ch < channels; ch += 1) {
    assert.equal(planes[ch].length, frames);
    for (let f = 0; f < frames; f += 1) {
      const expected = valueAt(ch + channelOffset, firstFrame + f);
      if (Math.abs(planes[ch][f] - expected) > tolerance) {
        assert.fail(`channel ${ch} frame ${firstFrame + f}: ${planes[ch][f]} != ${expected}`);
      }
    }
  }
}

test("a 24-bit 5.1 WAV reads any section exactly, labelled by its mask", async () => {
  const bytes = waveFile({ channels: 6, frames: 48000, channelMask: 0x3f });
  const source = await openRangedAudioSource(asFile(bytes));
  assert.equal(source.container, "wav");
  assert.equal(source.channels, 6);
  assert.equal(source.frames, 48000);
  assert.equal(source.sampleRate, 48000);
  assert.equal(source.bitDepth, 24);
  assert.deepEqual(source.labels, ["L", "R", "C", "LFE", "Ls", "Rs"]);
  assertFrames(await source.read(12345, 1000), { firstFrame: 12345, channels: 6, frames: 1000 });
  // Past the end is silence, not an error.
  const tail = await source.read(47990, 20);
  assert.equal(tail[0][9], valueAt(0, 47999));
  assert.equal(tail[0][10], 0);
});

test("an RF64 file's sizes come from its ds64 chunk", async () => {
  const bytes = waveFile({ channels: 2, frames: 1000, encoding: "int16", rf64: true });
  const source = await openRangedAudioSource(asFile(bytes));
  assert.equal(source.container, "rf64");
  assert.equal(source.frames, 1000);
  assertFrames(await source.read(0, 1000), { firstFrame: 0, channels: 2, frames: 1000 });
});

test("7.1 is read by position in cinema order; one surround pair is 5.1", () => {
  assert.deepEqual(labelsFromWaveChannelMask(0x63f, 8), ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs"]);
  assert.deepEqual(labelsFromWaveChannelMask(0x60f, 6), ["L", "R", "C", "LFE", "Ls", "Rs"]);
  assert.equal(labelsFromWaveChannelMask(0x3, 6), null);
});

for (const [name, entry, encoding, littleEndian] of [
  ["twos (16-bit big-endian, version 0)", qtV0("twos"), "int16", false],
  ["sowt (16-bit little-endian)", qtV0("sowt"), "int16", true],
  ["twos at 24 bits (its sample size names the width)", qtV0("twos"), "int24", false],
  ["sowt at 24 bits", qtV0("sowt"), "int24", true],
  ["twos at 32 bits", qtV0("twos"), "int32", false],
  ["in24 (24-bit big-endian)", qtV0("in24"), "int24", false],
  ["in24 with an enda atom (little-endian)", qtV0("in24", [box("wave", box("enda", u16(1)))]), "int24", true],
  ["lpcm version 2, 24-bit little-endian signed", qtV2Lpcm(0x4 | 0x8), "int24", true],
  ["lpcm version 2, 32-bit float big-endian", qtV2Lpcm(0x1 | 0x2 | 0x8), "float32", false],
]) {
  test(`a QuickTime master's ${name} sound reads across interleaved chunks`, async () => {
    const totalFrames = 20000;
    const bytes = quickTimeMovie({
      totalFrames,
      chunkFrames: 4800,
      soundTracks: [{ channels: 6, encoding, littleEndian, entry }],
    });
    const source = await openRangedAudioSource(asFile(bytes));
    assert.equal(source.container, "mov");
    assert.equal(source.channels, 6);
    assert.equal(source.frames, totalFrames);
    // A read spanning three chunks, each separated from the next by picture.
    assertFrames(await source.read(4000, 6000), { firstFrame: 4000, channels: 6, frames: 6000 });
    assertFrames(await source.read(19990, 10), { firstFrame: 19990, channels: 6, frames: 10 });
  });
}

test("an ISO ipcm track reads by its pcmC box", async () => {
  const bytes = quickTimeMovie({
    brand: "isom",
    totalFrames: 9600,
    soundTracks: [{ channels: 2, encoding: "int24", littleEndian: true, entry: isoIpcm, stszSize: 6 }],
  });
  const source = await openRangedAudioSource(asFile(bytes));
  assert.equal(source.container, "mp4");
  assertFrames(await source.read(100, 9000), { firstFrame: 100, channels: 2, frames: 9000 });
});

test("six mono tracks play the programme track until the caller names them as one bed", async () => {
  const soundTracks = Array.from({ length: 6 }, (_, i) => ({
    channels: 1,
    encoding: "int24",
    littleEndian: false,
    entry: qtV0("in24"),
    channelOffset: i,
  }));
  const bytes = quickTimeMovie({ totalFrames: 9600, soundTracks });
  // Whether mono feeds are one bed is the operator's statement (issue #1750).
  const programme = await openRangedAudioSource(asFile(bytes));
  assert.equal(programme.channels, 1);
  assert.equal(programme.tracks.length, 6);
  assert.deepEqual(programme.chosenTrackIndexes, [programme.tracks[0].index]);
  const bed = await openRangedAudioSource(asFile(bytes), { trackIndexes: programme.tracks.map((track) => track.index) });
  assert.equal(bed.channels, 6);
  assertFrames(await bed.read(500, 4000), { firstFrame: 500, channels: 6, frames: 4000 });
  // One track alone is also a programme.
  const single = await openRangedAudioSource(asFile(bytes), { trackIndexes: [programme.tracks[2].index] });
  assert.equal(single.channels, 1);
  assertFrames(await single.read(0, 100), { firstFrame: 0, channels: 1, channelOffset: 2, frames: 100 });
});

test("a disabled track stays in the inventory but the enabled one plays; an unsupported codec is refused in plain words", async () => {
  const bytes = quickTimeMovie({
    totalFrames: 4800,
    soundTracks: [
      { channels: 2, encoding: "int16", littleEndian: false, entry: qtV0("twos"), enabled: false },
      { channels: 2, encoding: "int16", littleEndian: false, entry: qtV0("twos"), channelOffset: 5 },
    ],
  });
  const source = await openRangedAudioSource(asFile(bytes));
  assert.equal(source.tracks.length, 2);
  assert.deepEqual(source.tracks.map((track) => track.enabled), [false, true]);
  assert.deepEqual(source.chosenTrackIndexes, [source.tracks[1].index]);
  assertFrames(await source.read(0, 10), { firstFrame: 0, channels: 2, channelOffset: 5, frames: 10 });

  const alac = quickTimeMovie({
    totalFrames: 4800,
    soundTracks: [{ channels: 2, encoding: "int16", littleEndian: false, entry: qtV0("alac") }],
  });
  await assert.rejects(openRangedAudioSource(asFile(alac)), (error) => error instanceof RangedAudioSourceError && /uncompressed \(PCM\) and AAC/.test(error.message) && !/alac/.test(error.message));
});

test("a lead empty edit is silence before the sound, and a media start skips into it", async () => {
  // Movie timescale 600: 300 units is half a second, 24000 frames at 48 kHz.
  const bytes = quickTimeMovie({
    totalFrames: 48000,
    soundTracks: [
      {
        channels: 1,
        encoding: "int16",
        littleEndian: false,
        entry: qtV0("twos"),
        edits: [
          { duration: 300, mediaTime: -1 },
          { duration: 600, mediaTime: 4800 },
        ],
      },
    ],
  });
  const source = await openRangedAudioSource(asFile(bytes));
  assert.equal(source.frames, 24000 + 43200);
  const planes = await source.read(23990, 20);
  assert.equal(planes[0][9], 0);
  assert.equal(planes[0][10], valueAt(0, 4800));
  assert.equal(planes[0][19], valueAt(0, 4809));
});

function rangeServer(bytes, { ignoreRange = false, failFirst = 0 } = {}) {
  const log = [];
  let failures = failFirst;
  const fetchImpl = async (_url, init) => {
    const header = init?.headers?.Range || "";
    log.push(header);
    if (failures > 0) {
      failures -= 1;
      return new Response("busy", { status: 503 });
    }
    const match = /bytes=(\d+)-(\d+)/.exec(header);
    if (!match || ignoreRange) return new Response(bytes, { status: 200 });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-type": "video/quicktime" },
    });
  };
  return { fetchImpl, log };
}

test("an AIFF stem reads by its big-endian samples; an MXF master is refused by name", async () => {
  const frames = 5000;
  const channels = 2;
  const pcm = pcmBytes({ channels, frames, encoding: "int24", littleEndian: false });
  const be32 = (v) => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  const be16 = (v) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
  // 48000 as an 80-bit extended float: exponent 16383 + 15, mantissa 48000 << 48.
  const rate = new Uint8Array([0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
  const chunk = (id, body) => concat([ascii(id), be32(body.length), body, body.length % 2 ? new Uint8Array(1) : new Uint8Array(0)]);
  const comm = chunk("COMM", concat([be16(channels), be32(frames), be16(24), rate]));
  const ssnd = chunk("SSND", concat([be32(0), be32(0), pcm]));
  const body = concat([ascii("AIFF"), comm, ssnd]);
  const aiff = concat([ascii("FORM"), be32(body.length), body]);
  const source = await openRangedAudioSource(asFile(aiff));
  assert.equal(source.container, "aiff");
  assert.equal(source.sampleRate, 48000);
  assertFrames(await source.read(1200, 3000), { firstFrame: 1200, channels, frames: 3000 });

  const mxf = new Uint8Array(64);
  mxf.set([0x06, 0x0e, 0x2b, 0x34, 0x02, 0x05, 0x01, 0x01]);
  await assert.rejects(openRangedAudioSource(asFile(mxf)), (error) => error.code === "format" && /MOV, MP4, WAV and AIFF/.test(error.message));
});

test("PCM conversion is exact at every supported width", () => {
  for (const encoding of ["int16", "int24", "int32", "float32"]) {
    for (const littleEndian of [true, false]) {
      const bytes = pcmBytes({ channels: 3, frames: 50, encoding, littleEndian });
      const out = Array.from({ length: 3 }, () => new Float32Array(50));
      decodeInterleavedPcm(bytes, { channels: 3, encoding, littleEndian }, out);
      assertFrames(out, { firstFrame: 0, channels: 3, frames: 50 });
    }
  }
});

test("a fragmented MOV or MP4 is refused rather than opened short", async () => {
  const bytes = quickTimeMovie({
    totalFrames: 4800,
    moovExtra: [box("mvex", box("trex", new Uint8Array(24)))],
    soundTracks: [{ channels: 2, encoding: "int24", littleEndian: false, entry: qtV0("in24") }],
  });
  await assert.rejects(openRangedAudioSource(asFile(bytes)), (error) => {
    assert.ok(error instanceof RangedAudioSourceError);
    assert.equal(error.code, "format");
    assert.match(error.message, /fragmented/);
    return true;
  });
});
