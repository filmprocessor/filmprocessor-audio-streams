// The audio application's 48 kHz programme rate for masters recorded at other rates:
// accuracy, the stopband, and that a range converted on its own matches the
// same range of a whole-programme conversion, which seeking and sectioned
// rendering rely on.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createResamplingKernel,
  exactSampleRate,
  inputSpanFor,
  integerSampleRate,
  resampleInto,
  resampledLength,
  resamplingSource,
} from "../src/resampler.js";

function tone(rate, frames, hz, amplitude = 0.5) {
  const plane = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) plane[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return plane;
}

function convertAll(kernel, input, outCount) {
  const span = inputSpanFor(kernel, 0, outCount);
  const padded = new Float32Array(span.end - span.start);
  const from = Math.max(0, span.start);
  const to = Math.min(input.length, span.end);
  padded.set(input.subarray(from, to), from - span.start);
  return resampleInto(kernel, padded, span.start, 0, outCount, new Float32Array(outCount));
}

function memorySource(rate, planes) {
  return {
    sampleRate: rate,
    channels: planes.length,
    frames: planes[0].length,
    async read(frame, count) {
      return planes.map((plane) => plane.slice(frame, frame + count));
    },
  };
}

test("rates reduce to their smallest ratio and lengths follow it", () => {
  const up = createResamplingKernel(44100, 48000);
  assert.equal(up.L, 160);
  assert.equal(up.M, 147);
  assert.equal(resampledLength(up, 44100), 48000);
  const down = createResamplingKernel(96000, 48000);
  assert.equal(down.L, 1);
  assert.equal(down.M, 2);
  assert.equal(resampledLength(down, 96001), 48001);
  assert.equal(createResamplingKernel(48000, 48000).identity, true);
  assert.equal(integerSampleRate(48000.0), 48000);
  assert.throws(() => integerSampleRate(47952.047952), /cannot be converted/);
  // A pull-down master (48 kHz played at 1000/1001) is an exact fraction.
  assert.deepEqual(exactSampleRate(47952.047952), { numerator: 48000000, denominator: 1001 });
  const pullUp = createResamplingKernel(47952.047952, 48000);
  assert.equal(pullUp.L, 1001);
  assert.equal(pullUp.M, 1000);
  assert.throws(() => exactSampleRate(47000.5), /cannot be converted/);
});

test("the passband is flat to 20 kHz and what folds back is 100 dB down", () => {
  for (const [from, to] of [[44100, 48000], [48000, 44100], [96000, 48000]]) {
    const kernel = createResamplingKernel(from, to);
    const length = to;
    const flat = convertAll(kernel, tone(from, from, 19900), length);
    let peak = 0;
    for (let n = 4000; n < length - 4000; n += 1) peak = Math.max(peak, Math.abs(flat[n]));
    assert.ok(Math.abs(20 * Math.log10(peak / 0.5)) < 0.01, `${from}->${to}: 19.9 kHz at ${20 * Math.log10(peak / 0.5)} dB`);
  }
  // 23 kHz at 44.1 kHz input does not exist; at 96 kHz going to 48 kHz it must vanish.
  const down = createResamplingKernel(96000, 48000);
  const alias = convertAll(down, tone(96000, 96000, 29000), 48000);
  let peak = 0;
  for (let n = 4000; n < 44000; n += 1) peak = Math.max(peak, Math.abs(alias[n]));
  assert.ok(20 * Math.log10(peak / 0.5) < -95, `alias at ${20 * Math.log10(peak / 0.5)} dB`);
});

test("a 1 kHz tone at 44.1 kHz arrives at 48 kHz within -90 dB", () => {
  const kernel = createResamplingKernel(44100, 48000);
  const input = tone(44100, 44100, 1000);
  const output = convertAll(kernel, input, 48000);
  let worst = 0;
  // Away from the programme's edges, where the window runs into silence.
  for (let n = 2000; n < 46000; n += 1) {
    worst = Math.max(worst, Math.abs(output[n] - 0.5 * Math.sin((2 * Math.PI * 1000 * n) / 48000)));
  }
  assert.ok(20 * Math.log10(worst) < -90, `error ${20 * Math.log10(worst)} dB`);
});

test("converting down, content above the new Nyquist is removed", () => {
  const kernel = createResamplingKernel(96000, 48000);
  const output = convertAll(kernel, tone(96000, 96000, 30000), 48000);
  let peak = 0;
  for (let n = 2000; n < 46000; n += 1) peak = Math.max(peak, Math.abs(output[n]));
  assert.ok(20 * Math.log10(peak / 0.5) < -70, `alias at ${20 * Math.log10(peak / 0.5)} dB`);
  const passband = convertAll(kernel, tone(96000, 96000, 10000), 48000);
  let error = 0;
  for (let n = 2000; n < 46000; n += 1) {
    error = Math.max(error, Math.abs(passband[n] - 0.5 * Math.sin((2 * Math.PI * 10000 * n) / 48000)));
  }
  assert.ok(20 * Math.log10(error) < -60, `passband error ${20 * Math.log10(error)} dB`);
});

test("a constant stays exactly constant", () => {
  const kernel = createResamplingKernel(88200, 48000);
  const output = convertAll(kernel, new Float32Array(88200).fill(0.25), 48000);
  for (let n = 1000; n < 47000; n += 1) assert.ok(Math.abs(output[n] - 0.25) < 1e-6);
});

test("any range converted on its own equals the same range of the whole", async () => {
  const input = [tone(44100, 30000, 440), tone(44100, 30000, 3700, 0.3)];
  const source = resamplingSource(memorySource(44100, input), 48000);
  assert.equal(source.sampleRate, 48000);
  assert.equal(source.frames, resampledLength(createResamplingKernel(44100, 48000), 30000));
  const whole = await source.read(0, source.frames);
  for (const [frame, count] of [[0, 1], [0, 997], [12345, 4000], [source.frames - 50, 50], [7, 1]]) {
    const part = await source.read(frame, count);
    for (let ch = 0; ch < 2; ch += 1) {
      for (let i = 0; i < count; i += 1) assert.equal(part[ch][i], whole[ch][frame + i]);
    }
  }
});

test("a 48 kHz source passes through untouched", async () => {
  const planes = [tone(48000, 1000, 100)];
  const base = memorySource(48000, planes);
  assert.equal(resamplingSource(base, 48000), base);
});
