// A waveform's peaks, read a section at a time.
//
// The Media Player used to draw a waveform by reading the whole file into
// memory and decoding all of its sound at once, so a feature film (several
// gigabytes, two hours of 5.1) could never have one: it was refused at 512 MB
// of file or 512 MB of decoded sound. This reads the sound a section at a
// time, folds each section straight into one minimum and maximum per column
// per channel, and lets the section go. What it holds is the columns
// (channels x columns x 2 floats) and one section, so memory follows the
// waveform's width, not the film's length.
//
// Two passes. The overview reads a short slice at evenly spaced points, so the
// shape of the whole programme is on screen within a second or two; it is
// labelled an overview because each of its columns stands for a slice, not for
// every sample under it. The full pass then reads every sample in order and
// replaces the overview column by column as it goes.
//
// The reader is the caller's: `readSection(startFrame, frameCount, signal)`
// resolves to one Float32Array per channel (ranged-audio-source.js for MOV,
// MP4, WAV and AIFF, through WebCodecs for AAC; FFmpeg.wasm sections for
// anything else). Runs in a page and under Node: no DOM.

export const WAVEFORM_OVERVIEW_PROBES = 256;

export class WaveformStreamCancelled extends Error {
    constructor() {
        super('The waveform read was superseded.');
        this.name = 'WaveformStreamCancelled';
    }
}

/**
 * Per-column minimum and maximum for `lanes` lanes. `mono-sum` folds every
 * source channel into one lane, averaged sample by sample as the whole-file
 * waveform does.
 */
export function createPeakColumns({ columns, lanes }) {
    const mins = Array.from({ length: lanes }, () => new Float32Array(columns).fill(1));
    const maxs = Array.from({ length: lanes }, () => new Float32Array(columns).fill(-1));
    return { columns, lanes, mins, maxs };
}

function foldSample(target, lane, column, value) {
    if (value < target.mins[lane][column]) target.mins[lane][column] = value;
    if (value > target.maxs[lane][column]) target.maxs[lane][column] = value;
}

/**
 * Fold `frames` frames of planar audio, the first at programme frame
 * `startFrame`, into the columns of a programme `totalFrames` long.
 */
export function foldSection(target, planes, { startFrame, frames, totalFrames, mode }) {
    const { columns } = target;
    if (!(totalFrames > 0) || !(frames > 0) || !planes.length) return;
    const channels = planes.length;
    let offset = 0;
    while (offset < frames) {
        const frame = startFrame + offset;
        if (frame >= totalFrames) break;
        const column = Math.min(columns - 1, Math.floor((frame * columns) / totalFrames));
        // The first frame of the next column; every frame before it is this column's.
        const nextColumnFrame = Math.ceil(((column + 1) * totalFrames) / columns);
        const end = Math.min(frames, offset + Math.max(1, nextColumnFrame - frame));
        if (mode === 'mono-sum') {
            let min = target.mins[0][column];
            let max = target.maxs[0][column];
            for (let i = offset; i < end; i += 1) {
                let sum = 0;
                for (let ch = 0; ch < channels; ch += 1) sum += planes[ch][i] || 0;
                const value = sum / channels;
                if (value < min) min = value;
                if (value > max) max = value;
            }
            target.mins[0][column] = min;
            target.maxs[0][column] = max;
        } else {
            for (let ch = 0; ch < target.lanes; ch += 1) {
                const plane = planes[ch];
                if (!plane) continue;
                let min = target.mins[ch][column];
                let max = target.maxs[ch][column];
                for (let i = offset; i < end; i += 1) {
                    const value = plane[i];
                    if (value < min) min = value;
                    if (value > max) max = value;
                }
                target.mins[ch][column] = min;
                target.maxs[ch][column] = max;
            }
        }
        offset = end;
    }
}

/**
 * The envelope a renderer draws: `{ min, max }` per column per lane. Columns
 * the full pass has reached come from it; the rest from the overview, where
 * there is one. An untouched column is silence.
 */
export function mergedEnvelope(full, overview, coveredColumns) {
    const lanes = [];
    for (let lane = 0; lane < full.lanes; lane += 1) {
        const out = new Array(full.columns);
        for (let c = 0; c < full.columns; c += 1) {
            const source = c < coveredColumns || !overview ? full : overview;
            const min = source.mins[lane][c];
            const max = source.maxs[lane][c];
            out[c] = min > max ? { min: 0, max: 0 } : { min, max };
        }
        lanes.push(out);
    }
    return lanes;
}

/**
 * Read a programme's waveform. Resolves to `{ envelope, complete }` with
 * `envelope[lane][column] = { min, max }`. `onUpdate({ envelope, phase,
 * progress })` is called with the overview once it is read and with the
 * merged envelope as the full pass advances (at most every `updateMs`).
 * `isCancelled()` is checked between reads; a superseded read rejects with
 * WaveformStreamCancelled and leaves nothing behind.
 */
export async function streamWaveformPeaks({
    readSection,
    totalFrames,
    sampleRate,
    channels,
    columns,
    mode = 'per-channel',
    sectionSeconds = 10,
    overviewProbes = WAVEFORM_OVERVIEW_PROBES,
    probeSeconds = 0.25,
    updateMs = 250,
    onUpdate = null,
    isCancelled = () => false,
    now = () => (globalThis.performance?.now?.() ?? Date.now()),
}) {
    if (!(totalFrames > 0) || !(sampleRate > 0) || !(channels > 0) || !(columns > 0)) {
        throw new Error('The waveform reader needs a length, a rate, channels and columns.');
    }
    const lanes = mode === 'mono-sum' ? 1 : channels;
    const check = () => {
        if (isCancelled()) throw new WaveformStreamCancelled();
    };

    // ── Overview: one short slice per probe, standing for its share of columns.
    let overview = null;
    const probes = Math.max(0, Math.min(overviewProbes, columns));
    if (probes > 1) {
        overview = createPeakColumns({ columns, lanes });
        const probeFrames = Math.max(1, Math.min(Math.round(probeSeconds * sampleRate), Math.floor(totalFrames / probes)));
        for (let k = 0; k < probes; k += 1) {
            check();
            const centre = Math.floor(((k + 0.5) * totalFrames) / probes);
            const start = Math.max(0, Math.min(totalFrames - probeFrames, centre - Math.floor(probeFrames / 2)));
            const planes = await readSection(start, probeFrames);
            check();
            const slice = createPeakColumns({ columns: 1, lanes });
            foldSection(slice, planes, { startFrame: 0, frames: probeFrames, totalFrames: probeFrames, mode });
            const from = Math.floor((k * columns) / probes);
            const to = Math.max(from + 1, Math.floor(((k + 1) * columns) / probes));
            for (let lane = 0; lane < lanes; lane += 1) {
                overview.mins[lane].fill(slice.mins[lane][0], from, to);
                overview.maxs[lane].fill(slice.maxs[lane][0], from, to);
            }
        }
        onUpdate?.({ envelope: mergedEnvelope(overview, null, 0), phase: 'overview', progress: 0 });
    }

    // ── Full pass: every sample, in order, section by section.
    const full = createPeakColumns({ columns, lanes });
    const sectionFrames = Math.max(1, Math.round(sectionSeconds * sampleRate));
    let lastUpdate = now();
    for (let start = 0; start < totalFrames; start += sectionFrames) {
        check();
        const frames = Math.min(sectionFrames, totalFrames - start);
        const planes = await readSection(start, frames);
        check();
        foldSection(full, planes, { startFrame: start, frames, totalFrames, mode });
        const done = start + frames;
        if (onUpdate && done < totalFrames && now() - lastUpdate >= updateMs) {
            lastUpdate = now();
            // A column is complete once the read has passed its last frame.
            const covered = Math.floor((done * columns) / totalFrames);
            onUpdate({ envelope: mergedEnvelope(full, overview, covered), phase: 'full', progress: done / totalFrames });
        }
    }
    check();
    return { envelope: mergedEnvelope(full, null, columns), complete: true };
}
