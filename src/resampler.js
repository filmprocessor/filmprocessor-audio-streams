// Sample-rate conversion for programmes too long to hold in memory.
//
// A polyphase windowed-sinc converter between two sample rates. Every output
// frame is computed from a fixed window of input frames around its position on
// the global timeline, so the converter keeps no state: any range of output
// can be produced on its own, from the input span `inputSpanFor()` names, and
// the result is identical to converting the whole programme in one go. That is
// what lets the audio application seek in a feature-length master and render it in
// sections without seams.
//
// The filter is flat to 20 kHz and rejects images and aliases by 100 dB: the
// transition band runs from 20 kHz to (lower rate − 20 kHz), centred on the
// lower Nyquist frequency, so anything that folds back lands above 20 kHz.

const STOPBAND_DB = 100;
const PASSBAND_EDGE_HZ = 20000;

function gcd(a, b) {
    let x = a;
    let y = b;
    while (y) [x, y] = [y, x % y];
    return x;
}

function besselI0(x) {
    let sum = 1;
    let term = 1;
    const quarter = (x * x) / 4;
    for (let k = 1; k < 64; k += 1) {
        term *= quarter / (k * k);
        sum += term;
        if (term < sum * 1e-17) break;
    }
    return sum;
}

function sinc(x) {
    if (x === 0) return 1;
    const px = Math.PI * x;
    return Math.sin(px) / px;
}

// The video pull-down family: 48 kHz played at 1000/1001 speed. QuickTime
// stores such a rate as a float (47952.047952…), never as a whole number.
const PULL_DOWN_BASES = [32000, 44100, 48000, 88200, 96000, 176400, 192000];

/**
 * A container's sample rate as an exact fraction {numerator, denominator}:
 * a whole number of hertz, or a pull-down rate (base × 1000/1001). Anything
 * else is refused rather than silently rounded.
 */
export function exactSampleRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value < 1000 || value > 768000) {
        throw new RangeError(`A sample rate of ${rate} Hz cannot be converted.`);
    }
    const whole = Math.round(value);
    if (Math.abs(value - whole) <= 1e-6) return { numerator: whole, denominator: 1 };
    for (const base of PULL_DOWN_BASES) {
        if (Math.abs(value - (base * 1000) / 1001) < 0.01) return { numerator: base * 1000, denominator: 1001 };
    }
    throw new RangeError(`A sample rate of ${rate} Hz cannot be converted.`);
}

/** Kept for callers that need a whole-hertz rate. */
export function integerSampleRate(rate) {
    const exact = exactSampleRate(rate);
    if (exact.denominator !== 1) throw new RangeError(`A sample rate of ${rate} Hz cannot be converted.`);
    return exact.numerator;
}

/**
 * Build the converter for `inRate` → `outRate`. Output frame n sits at input
 * position n·M/L, where L/M is the reduced ratio outRate/inRate.
 */
export function createResamplingKernel(inRate, outRate) {
    const input = exactSampleRate(inRate);
    const output = exactSampleRate(outRate);
    // outRate / inRate = (on / od) / (in / id) = (on · id) / (od · in)
    let L = output.numerator * input.denominator;
    let M = output.denominator * input.numerator;
    const divisor = gcd(L, M);
    L /= divisor;
    M /= divisor;
    const inHz = input.numerator / input.denominator;
    const outHz = output.numerator / output.denominator;
    if (L === M) {
        return Object.freeze({ inRate: inHz, outRate: outHz, L: 1, M: 1, identity: true, halfLength: 0, taps: 1, phases: null });
    }
    const lowerRate = Math.min(inHz, outHz);
    const passEdge = Math.min(PASSBAND_EDGE_HZ, 0.4535 * lowerRate);
    const stopEdge = lowerRate - passEdge;
    // Cutoff and transition width as fractions of the input rate.
    const cutoff = (lowerRate / 2) / (inHz / 2); // relative to the input's Nyquist
    const transition = (stopEdge - passEdge) / inHz;
    const length = Math.ceil((STOPBAND_DB - 7.95) / (14.36 * transition));
    const halfLength = Math.max(2, Math.ceil(length / 2));
    const taps = 2 * halfLength;
    const beta = 0.1102 * (STOPBAND_DB - 8.7);
    const windowNorm = besselI0(beta);
    const phases = new Float32Array(L * taps);
    for (let phase = 0; phase < L; phase += 1) {
        const frac = phase / L;
        const offset = phase * taps;
        let sum = 0;
        for (let k = 0; k < taps; k += 1) {
            // Input frame (i - halfLength + 1 + k) against position i + frac.
            const t = (k - halfLength + 1) - frac;
            const ratio = t / halfLength;
            const window = Math.abs(ratio) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - ratio * ratio)) / windowNorm;
            const value = Math.min(1, cutoff) * sinc(Math.min(1, cutoff) * t) * window;
            phases[offset + k] = value;
            sum += value;
        }
        // Unity gain at DC for every phase, so a constant stays exactly constant.
        for (let k = 0; k < taps; k += 1) phases[offset + k] /= sum;
    }
    return Object.freeze({ inRate: inHz, outRate: outHz, L, M, identity: false, halfLength, taps, phases });
}

/** Output frames produced from `inputFrames` input frames. */
export function resampledLength(kernel, inputFrames) {
    if (kernel.identity) return inputFrames;
    return Math.ceil((inputFrames * kernel.L) / kernel.M);
}

/** Input frames, as [start, end), that output frames [outFrame, outFrame + count) read. */
export function inputSpanFor(kernel, outFrame, count) {
    if (kernel.identity) return { start: outFrame, end: outFrame + count };
    if (count <= 0) return { start: 0, end: 0 };
    const first = Math.floor((outFrame * kernel.M) / kernel.L);
    const last = Math.floor(((outFrame + count - 1) * kernel.M) / kernel.L);
    return { start: first - kernel.halfLength + 1, end: last + kernel.halfLength + 1 };
}

/**
 * Convert one channel. `input` holds input frames starting at global frame
 * `inputStart` and must cover `inputSpanFor(kernel, outFrame, count)` (frames
 * outside the programme read as silence, so the caller zero-fills them).
 */
export function resampleInto(kernel, input, inputStart, outFrame, count, out, outOffset = 0) {
    if (kernel.identity) {
        out.set(input.subarray(outFrame - inputStart, outFrame - inputStart + count), outOffset);
        return out;
    }
    const { L, M, taps, halfLength, phases } = kernel;
    // n·M stays exact in a double far beyond any programme's length.
    let position = outFrame * M;
    for (let n = 0; n < count; n += 1) {
        const index = Math.floor(position / L);
        const phase = position - index * L;
        const base = index - halfLength + 1 - inputStart;
        const offset = phase * taps;
        let acc = 0;
        for (let k = 0; k < taps; k += 1) acc += phases[offset + k] * input[base + k];
        out[outOffset + n] = acc;
        position += M;
    }
    return out;
}

/**
 * Wrap a source ({sampleRate, frames, channels, read(frame, count, signal)}
 * returning planar Float32 at its own rate) so it reads at `outRate`.
 * `frames` overrides the converted length when the caller fixes it (a round
 * trip that must come back to its original length, say).
 */
export function resamplingSource(source, outRate, { frames: fixedFrames = null } = {}) {
    const kernel = createResamplingKernel(source.sampleRate, outRate);
    if (kernel.identity && fixedFrames === null) return source;
    const frames = fixedFrames ?? resampledLength(kernel, source.frames);
    return {
        ...source,
        sampleRate: kernel.outRate,
        frames,
        durationSeconds: frames / kernel.outRate,
        sourceSampleRate: kernel.inRate,
        async read(frame, count, signal) {
            const span = inputSpanFor(kernel, frame, count);
            const readStart = Math.max(0, span.start);
            const readEnd = Math.min(source.frames, span.end);
            const planes = readEnd > readStart ? await source.read(readStart, readEnd - readStart, signal) : [];
            const out = [];
            for (let ch = 0; ch < source.channels; ch += 1) {
                const input = new Float32Array(span.end - span.start);
                if (planes[ch]) input.set(planes[ch].subarray(0, readEnd - readStart), readStart - span.start);
                const plane = resampleInto(kernel, input, span.start, frame, count, new Float32Array(count));
                // Past the fixed length is silence.
                if (frame + count > frames) plane.fill(0, Math.max(0, frames - frame));
                out.push(plane);
            }
            return out;
        },
    };
}
