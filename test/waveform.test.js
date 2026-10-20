import assert from "node:assert/strict";
import test from "node:test";
import {
  createPeakColumns,
  foldSection,
  mergedEnvelope,
  streamWaveformPeaks,
  WaveformStreamCancelled,
} from "../src/waveform.js";

// A deterministic programme: each channel its own shape, so a lane swap would show.
const sample = (channel, frame) => Math.sin(frame / (37 + channel * 11)) * (0.2 + 0.1 * channel) * ((frame % 997) / 997);

function planesFor(channels, start, count) {
  return Array.from({ length: channels }, (_, ch) => Float32Array.from({ length: count }, (_, i) => sample(ch, start + i)));
}

// Whole-file columns, the way the whole-file waveform builds them.
function bruteColumns({ channels, totalFrames, columns, mode }) {
  const out = mode === "mono-sum" ? [[]] : Array.from({ length: channels }, () => []);
  for (let c = 0; c < columns; c += 1) {
    const start = Math.ceil((c * totalFrames) / columns);
    const end = Math.ceil(((c + 1) * totalFrames) / columns);
    for (let lane = 0; lane < out.length; lane += 1) {
      let min = 1;
      let max = -1;
      for (let f = start; f < end; f += 1) {
        let value;
        if (mode === "mono-sum") {
          let sum = 0;
          for (let ch = 0; ch < channels; ch += 1) sum += Math.fround(sample(ch, f));
          value = sum / channels;
        } else value = Math.fround(sample(lane, f));
        if (value < min) min = value;
        if (value > max) max = value;
      }
      out[lane].push(min > max ? { min: 0, max: 0 } : { min: Math.fround(min), max: Math.fround(max) });
    }
  }
  return out;
}

const close = (a, b) => Math.abs(a - b) < 1e-6;

for (const mode of ["per-channel", "mono-sum"]) {
  test(`streamed ${mode} columns are exactly the whole-file minimum and maximum`, async () => {
    const channels = 6;
    const totalFrames = 48000 * 7 + 123;
    const columns = 997;
    const asked = [];
    const updates = [];
    const { envelope } = await streamWaveformPeaks({
      readSection: async (start, count) => {
        asked.push([start, count]);
        return planesFor(channels, start, count);
      },
      totalFrames,
      sampleRate: 48000,
      channels,
      columns,
      mode,
      sectionSeconds: 1,
      overviewProbes: 32,
      updateMs: 0,
      onUpdate: (update) => updates.push(update),
    });
    const expected = bruteColumns({ channels, totalFrames, columns, mode });
    assert.equal(envelope.length, mode === "mono-sum" ? 1 : channels);
    envelope.forEach((lane, l) => lane.forEach((peak, c) => {
      assert.ok(close(peak.min, expected[l][c].min) && close(peak.max, expected[l][c].max), `lane ${l} column ${c}`);
    }));
    // The overview comes first, then the full pass advances.
    assert.equal(updates[0].phase, "overview");
    const progress = updates.filter((u) => u.phase === "full").map((u) => u.progress);
    assert.ok(progress.length > 2 && progress.every((p, i) => i === 0 || p > progress[i - 1]));
    // No read is longer than a section, and the full pass covers every frame once, in order.
    assert.ok(asked.every(([, count]) => count <= 48000));
    const full = asked.slice(32);
    let next = 0;
    for (const [start, count] of full) {
      assert.equal(start, next);
      next += count;
    }
    assert.equal(next, totalFrames);
  });
}

test("a column the full pass has not reached still shows the overview", () => {
  const full = createPeakColumns({ columns: 4, lanes: 1 });
  const overview = createPeakColumns({ columns: 4, lanes: 1 });
  foldSection(full, [Float32Array.of(0.1, -0.1, 0.2, -0.2)], { startFrame: 0, frames: 4, totalFrames: 16, mode: "per-channel" });
  overview.mins[0].fill(-0.9);
  overview.maxs[0].fill(0.9);
  const merged = mergedEnvelope(full, overview, 1);
  assert.ok(close(merged[0][0].max, 0.2));
  assert.deepEqual(merged[0].slice(1).map((p) => p.max).map((v) => Math.round(v * 10)), [9, 9, 9]);
});

test("a superseded read stops before its next section and leaves no result", async () => {
  let reads = 0;
  let cancelled = false;
  await assert.rejects(streamWaveformPeaks({
    readSection: async (start, count) => {
      reads += 1;
      if (reads === 5) cancelled = true;
      return planesFor(2, start, count);
    },
    totalFrames: 48000 * 60,
    sampleRate: 48000,
    channels: 2,
    columns: 100,
    sectionSeconds: 1,
    overviewProbes: 0,
    isCancelled: () => cancelled,
  }), (error) => error instanceof WaveformStreamCancelled);
  assert.equal(reads, 5);
});
