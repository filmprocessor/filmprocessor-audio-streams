// AAC sections share one WebCodecs decoder. A decoder per read cost WebKit about 2.5 MB each until a
// collection it rarely ran, so a feature film's waveform (about a thousand reads) grew the page by
// gigabytes. Here a synthetic AAC MP4 is read through a stand-in AudioDecoder that counts its own
// construction and writes each access unit's index into its output, so placement is checked exactly.
import assert from "node:assert/strict";
import test from "node:test";
import { openRangedAudioSource } from "../src/audio-source.js";
import { ascii, asFile, box, concat, u16, u32 } from "./helpers/media-fixtures.js";

const FRAME = 1024;
const RATE = 48000;
const UNIT_BYTES = 12;
const fullBox = (type, version, flags, ...payload) =>
  box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload);

// AudioSpecificConfig for AAC-LC, 48 kHz, stereo: 00010 0011 0010 000.
const ASC = new Uint8Array([0x11, 0x90]);

function esds() {
  const descriptor = (tag, body) => concat([new Uint8Array([tag, body.length]), body]);
  const specific = descriptor(5, ASC);
  const decoderConfig = descriptor(4, concat([new Uint8Array([0x40, 0x15, 0, 0, 0]), u32(0), u32(0), specific]));
  const sl = descriptor(6, new Uint8Array([2]));
  return fullBox("esds", 0, 0, descriptor(3, concat([u16(1), new Uint8Array([0]), decoderConfig, sl])));
}

function aacMovie(units, unitsPerChunk = 8) {
  const ftyp = box("ftyp", ascii("isom"), u32(0), ascii("isom"));
  const chunkOffsets = [];
  const parts = [];
  let cursor = ftyp.length + 8;
  for (let u = 0; u < units; u += unitsPerChunk) {
    chunkOffsets.push(cursor);
    const count = Math.min(unitsPerChunk, units - u);
    const bytes = new Uint8Array(count * UNIT_BYTES);
    for (let i = 0; i < count; i += 1) bytes[i * UNIT_BYTES] = (u + i) & 0xff;
    parts.push(bytes);
    cursor += bytes.length;
    // A picture chunk between sound chunks, as a muxer interleaves them.
    const picture = new Uint8Array(500).fill(0xee);
    parts.push(picture);
    cursor += picture.length;
  }
  const mdatBody = concat(parts);
  const mdat = concat([u32(mdatBody.length + 8), ascii("mdat"), mdatBody]);
  const entry = box("mp4a", new Uint8Array(6), u16(1), u32(0), u32(0), u16(2), u16(16), u16(0), u16(0), u32(RATE * 65536), esds());
  const last = units - (chunkOffsets.length - 1) * unitsPerChunk;
  const stscEntries = last === unitsPerChunk ? [[1, unitsPerChunk]] : [[1, unitsPerChunk], [chunkOffsets.length, last]];
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, u32(1), entry),
    fullBox("stts", 0, 0, u32(1), u32(units), u32(FRAME)),
    fullBox("stsc", 0, 0, u32(stscEntries.length), ...stscEntries.flatMap(([first, per]) => [u32(first), u32(per), u32(1)])),
    fullBox("stsz", 0, 0, u32(UNIT_BYTES), u32(units)),
    fullBox("stco", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map((o) => u32(o))),
  );
  const trak = box(
    "trak",
    fullBox("tkhd", 0, 3, new Uint8Array(80)),
    box(
      "mdia",
      fullBox("mdhd", 0, 0, u32(0), u32(0), u32(RATE), u32(units * FRAME), u16(0), u16(0)),
      fullBox("hdlr", 0, 0, u32(0), ascii("soun"), new Uint8Array(12), new Uint8Array([0])),
      box("minf", stbl),
    ),
  );
  const moov = box("moov", fullBox("mvhd", 0, 0, u32(0), u32(0), u32(600), u32(0), new Uint8Array(80)), trak);
  return concat([ftyp, mdat, moov]);
}

// Each output sample is unit index / 1000, plus 0.5 on the second channel.
function installStandInDecoder() {
  const stats = { constructed: 0, configured: 0, resets: 0, closed: 0, active: 0, maxActiveDecodes: 0 };
  class StandInAudioDecoder {
    constructor({ output, error }) {
      stats.constructed += 1;
      this.output = output;
      this.error = error;
      this.state = "unconfigured";
      this.queue = [];
    }
    configure(config) {
      assert.deepEqual([...config.description], [...ASC]);
      stats.configured += 1;
      this.state = "configured";
    }
    reset() {
      stats.resets += 1;
      this.queue = [];
      this.state = "unconfigured";
    }
    decode(chunk) {
      assert.equal(this.state, "configured", "decode on an unconfigured decoder");
      this.queue.push(chunk);
    }
    async flush() {
      stats.active += 1;
      stats.maxActiveDecodes = Math.max(stats.maxActiveDecodes, stats.active);
      await new Promise((resolve) => setImmediate(resolve));
      const chunks = this.queue;
      this.queue = [];
      for (const chunk of chunks) {
        const unit = Math.round((chunk.timestamp * RATE) / 1e6 / FRAME);
        this.output({
          timestamp: chunk.timestamp,
          numberOfFrames: FRAME,
          numberOfChannels: 2,
          copyTo(dest, { planeIndex }) {
            dest.fill(unit / 1000 + planeIndex * 0.5);
          },
          close() {},
        });
      }
      stats.active -= 1;
    }
    close() {
      stats.closed += 1;
      this.state = "closed";
    }
  }
  globalThis.AudioDecoder = StandInAudioDecoder;
  globalThis.EncodedAudioChunk = class {
    constructor({ timestamp, data }) {
      this.timestamp = timestamp;
      this.data = data;
    }
  };
  return stats;
}

function assertSection(planes, startFrame, count) {
  for (const frame of [0, 1, FRAME - 1, FRAME, Math.floor(count / 2), count - 1]) {
    const unit = Math.floor((startFrame + frame) / FRAME);
    assert.equal(planes[0][frame], Math.fround(unit / 1000), `L at frame ${startFrame + frame}`);
    assert.equal(planes[1][frame], Math.fround(unit / 1000 + 0.5), `R at frame ${startFrame + frame}`);
  }
}

test("every read of an AAC track goes through one decoder, reset between reads", async () => {
  const stats = installStandInDecoder();
  const source = await openRangedAudioSource(asFile(aacMovie(400)));
  assert.equal(source.channels, 2);
  assert.equal(source.frames, 400 * FRAME);
  for (const start of [0, 50 * FRAME + 300, 200 * FRAME, 399 * FRAME - 10]) {
    const count = Math.min(20 * FRAME, source.frames - start);
    assertSection(await source.read(start, count), start, count);
  }
  assert.equal(stats.constructed, 1, "one decoder for the whole track");
  assert.equal(stats.configured, 4, "configured once per read");
  assert.equal(stats.closed, 0);
});

test("reads asked for together decode one at a time and each lands in its own section", async () => {
  const stats = installStandInDecoder();
  const source = await openRangedAudioSource(asFile(aacMovie(300)));
  const starts = [0, 40 * FRAME, 120 * FRAME, 250 * FRAME + 17];
  const sections = await Promise.all(starts.map((start) => source.read(start, 30 * FRAME)));
  sections.forEach((planes, i) => assertSection(planes, starts[i], 30 * FRAME));
  assert.equal(stats.constructed, 1);
  assert.equal(stats.maxActiveDecodes, 1, "the shared decoder never runs two reads at once");
});

test("a decoder that fails is replaced on the next read, and the failed read says so", async () => {
  const stats = installStandInDecoder();
  const Original = globalThis.AudioDecoder;
  let failNext = true;
  globalThis.AudioDecoder = class extends Original {
    async flush() {
      if (failNext) {
        failNext = false;
        this.state = "closed";
        throw new Error("decode failed");
      }
      return super.flush();
    }
  };
  const source = await openRangedAudioSource(asFile(aacMovie(100)));
  await assert.rejects(source.read(0, 10 * FRAME), /could not decode/);
  assertSection(await source.read(10 * FRAME, 10 * FRAME), 10 * FRAME, 10 * FRAME);
  assert.equal(stats.constructed, 2, "a closed decoder is replaced");
});

test("a local file's nearby sound runs are read as one slice each section", async () => {
  installStandInDecoder();
  const bytes = aacMovie(400);
  const blob = asFile(bytes);
  let slices = 0;
  const counting = { size: blob.size, slice: (start, end) => { slices += 1; return blob.slice(start, end); } };
  const source = await openRangedAudioSource(counting);
  slices = 0;
  // 40 access units in five chunks, each chunk 500 picture bytes from the next.
  assertSection(await source.read(100 * FRAME, 40 * FRAME), 100 * FRAME, 40 * FRAME);
  assert.equal(slices, 1, `one slice for the section's runs, not one per chunk (${slices})`);
});
