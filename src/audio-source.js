/** Section-based PCM/AAC reads from a Blob or caller-supplied byte source. */
const MIB = 1024 * 1024;
// An AudioWorklet output and a ChannelSplitter carry at most 32 channels.
export const MAX_PROGRAMME_CHANNELS = 32;

export class RangedAudioSourceError extends Error {
    constructor(message, { code = 'unsupported', cause } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'RangedAudioSourceError';
        this.code = code;
    }
}

const RANGE_CONCURRENCY = 4;
/** Map with at most `limit` calls in flight, results in input order. */
async function mapLimited(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

/** Byte runs ({start, length}) of a source, in order, a bounded few at a time. */
// A local file's sound runs that sit close together are read as one slice and
// cut apart here. Each Blob slice is an object the browser tracks until it is
// collected (WebKit keeps a record of every one in its network process), and a
// film's sound interleaved with its pictures is thousands of short runs a few
// hundred kilobytes apart: read one by one, a two-hour 5.1 waveform grew
// WebKit's network process by half a gigabyte. Reading the picture bytes
// between them costs far less. Byte sources with their own reads (HTTP) keep
// their exact runs: there a gap is bandwidth.
const LOCAL_RUN_GAP_BYTES = 1024 * 1024;
const LOCAL_SPAN_BYTES = 16 * 1024 * 1024;

function coalesceLocalRuns(runs) {
    const order = runs.map((run, index) => ({ ...run, index })).sort((a, b) => a.start - b.start);
    const spans = [];
    for (const run of order) {
        const span = spans[spans.length - 1];
        const end = run.start + run.length;
        if (span && run.start - span.end <= LOCAL_RUN_GAP_BYTES && Math.max(span.end, end) - span.start <= LOCAL_SPAN_BYTES) {
            span.end = Math.max(span.end, end);
            span.members.push(run);
        } else {
            spans.push({ start: run.start, end, members: [run] });
        }
    }
    return spans;
}

async function readRuns(blob, runs, signal) {
    if (typeof blob.readMany === 'function') return blob.readMany(runs, signal);
    if (typeof blob.read === 'function') {
        return mapLimited(runs, RANGE_CONCURRENCY, (run) => readBytes(blob, run.start, run.length, signal));
    }
    const spans = coalesceLocalRuns(runs);
    const out = new Array(runs.length);
    await mapLimited(spans, RANGE_CONCURRENCY, async (span) => {
        const bytes = await readBytes(blob, span.start, span.end - span.start, signal);
        for (const run of span.members) out[run.index] = bytes.subarray(run.start - span.start, run.start - span.start + run.length);
    });
    return out;
}

function copyBuffer(bytes) {
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer;
}
async function readBytes(blob, start, length, signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    if (typeof blob.read === 'function') return blob.read(start, length, signal);
    return new Uint8Array(await blob.slice(start, start + length).arrayBuffer());
}

function fourcc(view, offset) {
    return String.fromCharCode(
        view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
}

// ─── PCM sample conversion ─────────────────────────────────────────────

/**
 * Interleaved PCM bytes to planar Float32. `encoding` is one of
 * int8u, int8, int16, int24, int32, float32, float64; `littleEndian` applies
 * to every width above 8 bits.
 */
export function decodeInterleavedPcm(bytes, { channels, encoding, littleEndian, frames }, out, outOffset = 0) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = PCM_WIDTH[encoding];
    const frameBytes = width * channels;
    const count = frames ?? Math.floor(bytes.byteLength / frameBytes);
    for (let frame = 0; frame < count; frame += 1) {
        const base = frame * frameBytes;
        for (let ch = 0; ch < channels; ch += 1) {
            const at = base + ch * width;
            let value;
            switch (encoding) {
                case 'int8u': value = (view.getUint8(at) - 128) / 128; break;
                case 'int8': value = view.getInt8(at) / 128; break;
                case 'int16': value = view.getInt16(at, littleEndian) / 32768; break;
                case 'int24': {
                    const b0 = view.getUint8(at);
                    const b1 = view.getUint8(at + 1);
                    const b2 = view.getUint8(at + 2);
                    let int = littleEndian ? (b0 | (b1 << 8) | (b2 << 16)) : ((b0 << 16) | (b1 << 8) | b2);
                    if (int & 0x800000) int -= 0x1000000;
                    value = int / 8388608;
                    break;
                }
                case 'int32': value = view.getInt32(at, littleEndian) / 2147483648; break;
                case 'float32': value = view.getFloat32(at, littleEndian); break;
                case 'float64': value = view.getFloat64(at, littleEndian); break;
                default: throw new RangedAudioSourceError(`Unknown sample encoding ${encoding}.`);
            }
            out[ch][outOffset + frame] = value;
        }
    }
    return count;
}

const PCM_WIDTH = Object.freeze({ int8u: 1, int8: 1, int16: 2, int24: 3, int32: 4, float32: 4, float64: 8 });

// ─── Channel labels ────────────────────────────────────────────────────

// WAVE_FORMAT_EXTENSIBLE speaker bits, in mask order.
const WAVE_SPEAKER_BITS = [
    [0x1, 'L'], [0x2, 'R'], [0x4, 'C'], [0x8, 'LFE'], [0x10, 'BL'], [0x20, 'BR'],
    [0x40, 'FLC'], [0x80, 'FRC'], [0x100, 'BC'], [0x200, 'SL'], [0x400, 'SR'],
    [0x800, 'Tc'], [0x1000, 'Ltf'], [0x2000, 'Ctf'], [0x4000, 'Rtf'], [0x8000, 'Ltr'],
    [0x10000, 'Ctr'], [0x20000, 'Rtr'],
];

/**
 * Speaker labels from a WAVE channel mask, in the cinema vocabulary the
 * audio application and DCP Studio use. A single surround pair, side or back, is the
 * 5.1 Ls/Rs. With both pairs present the file is 7.1, and 7.1 is read by
 * position in cinema order (L R C LFE Lss Rss Lrs Rrs), the order the
 * audio application itself writes under the 7.1 mask: the first surround pair in the
 * file is the sides. Null unless the mask names every channel.
 */
export function labelsFromWaveChannelMask(mask, channels) {
    if (!mask) return null;
    const named = WAVE_SPEAKER_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, name]) => name);
    if (named.length !== channels) return null;
    const surrounds = named.filter((name) => ['BL', 'BR', 'SL', 'SR'].includes(name));
    if (surrounds.length === 4) {
        const cinema = ['Lss', 'Rss', 'Lrs', 'Rrs'];
        let next = 0;
        return named.map((name) => (surrounds.includes(name) ? cinema[next++] : name));
    }
    const rename = { SL: 'Ls', SR: 'Rs', BL: 'Ls', BR: 'Rs' };
    return named.map((name) => rename[name] || name);
}

// QuickTime AudioChannelLabel values that name a speaker, in the speaker-role
// vocabulary the audio application places channels by (speaker-roles.js). A mono
// programme channel is a centre.
const QT_CHANNEL_LABELS = new Map([
    [1, 'L'], [2, 'R'], [3, 'C'], [4, 'LFE'], [5, 'Ls'], [6, 'Rs'], [7, 'Lc'], [8, 'Rc'],
    [9, 'Cs'], [10, 'Lss'], [11, 'Rss'], [12, 'Tc'], [13, 'Ltf'], [14, 'Ctf'], [15, 'Rtf'],
    [16, 'Ltr'], [17, 'Ctr'], [18, 'Rtr'], [33, 'Lrs'], [34, 'Rrs'], [42, 'C'],
]);

/**
 * A 7.1 named as two surround pairs: Core Audio's "surround" pair beside a
 * rear pair is the side pair (Apple lists 7.1 as L R C LFE Ls Rs Rls Rrs), and
 * beside a "surround direct" (side) pair it is the rear pair.
 */
function resolveSurroundPairs(labels) {
    const has = (name) => labels.includes(name);
    if (has('Ls') && has('Rs') && has('Lrs') && has('Rrs')) {
        return labels.map((name) => ({ Ls: 'Lss', Rs: 'Rss' }[name] || name));
    }
    if (has('Ls') && has('Rs') && has('Lss') && has('Rss')) {
        return labels.map((name) => ({ Ls: 'Lrs', Rs: 'Rrs' }[name] || name));
    }
    return labels;
}

// The layout tags (high 16 bits) whose channel order is fixed by Core Audio.
const QT_LAYOUT_TAGS = new Map([
    [100, ['C']],
    [101, ['L', 'R']],
    [113, ['L', 'R', 'C']],
    [121, ['L', 'R', 'C', 'LFE', 'Ls', 'Rs']], // MPEG_5_1_A
    [124, ['C', 'L', 'R', 'Ls', 'Rs', 'LFE']], // MPEG_5_1_D
    [128, ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs']], // MPEG_7_1_C: L R C LFE Ls Rs Rls Rrs
    [146, ['L', 'R', 'C', 'LFE', 'Ls', 'Rs']], // SMPTE_DTV / ITU_3_2_1
]);

function labelsFromQuickTimeChan(view, offset, length, channels) {
    if (length < 12) return null;
    const tag = view.getUint32(offset);
    const bitmap = view.getUint32(offset + 4);
    const count = view.getUint32(offset + 8);
    if (tag === 0) {
        if (count !== channels || length < 12 + count * 20) return null;
        const labels = [];
        for (let i = 0; i < count; i += 1) {
            const label = QT_CHANNEL_LABELS.get(view.getUint32(offset + 12 + i * 20));
            if (!label) return null;
            labels.push(label);
        }
        return new Set(labels).size === labels.length ? resolveSurroundPairs(labels) : null;
    }
    if (tag === 0x10000) return labelsFromWaveChannelMask(bitmap, channels);
    const fixed = QT_LAYOUT_TAGS.get(tag >>> 16);
    return fixed && fixed.length === channels ? fixed : null;
}

// ─── WAV / BWF / RF64 ──────────────────────────────────────────────────

async function parseWave(blob) {
    const head = await readBytes(blob, 0, Math.min(blob.size, 64 * 1024));
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const riff = fourcc(view, 0);
    let ds64DataSize = null;
    let format = null;
    let data = null;
    let pos = 12;
    // Walk the chunks. A long file's data chunk begins inside the first 64 KiB
    // in every writer we know; read further headers by range if it does not.
    let window = head;
    let windowStart = 0;
    while (pos + 8 <= blob.size) {
        if (pos + 8 > windowStart + window.length) {
            windowStart = pos;
            window = await readBytes(blob, pos, Math.min(blob.size - pos, 64 * 1024));
        }
        const v = new DataView(window.buffer, window.byteOffset, window.byteLength);
        const at = pos - windowStart;
        const id = fourcc(v, at);
        let size = v.getUint32(at + 4, true);
        const body = pos + 8;
        if (id === 'ds64' && at + 8 + 24 <= window.length) {
            ds64DataSize = v.getUint32(at + 8 + 8, true) + v.getUint32(at + 8 + 12, true) * 0x100000000;
        } else if (id === 'fmt ' && at + 8 + 16 <= window.length) {
            const formatTag = v.getUint16(at + 8, true);
            const channels = v.getUint16(at + 10, true);
            const sampleRate = v.getUint32(at + 12, true);
            const blockAlign = v.getUint16(at + 20, true);
            const bits = v.getUint16(at + 22, true);
            let subFormat = formatTag;
            let validBits = bits;
            let channelMask = 0;
            if (formatTag === 0xfffe && size >= 40 && at + 8 + 40 <= window.length) {
                validBits = v.getUint16(at + 26, true) || bits;
                channelMask = v.getUint32(at + 28, true);
                subFormat = v.getUint16(at + 32, true);
            }
            format = { subFormat, channels, sampleRate, blockAlign, bits, validBits, channelMask };
        } else if (id === 'data') {
            if (riff !== 'RIFF' && size === 0xffffffff && ds64DataSize !== null) size = ds64DataSize;
            data = { offset: body, size: Math.min(size, blob.size - body) };
            break;
        }
        pos = body + size + (size % 2);
    }
    if (!format) throw new RangedAudioSourceError('This WAV file is incomplete.');
    if (!data) throw new RangedAudioSourceError('This WAV file has no sound.');
    let encoding = null;
    if (format.subFormat === 1) {
        encoding = { 8: 'int8u', 16: 'int16', 24: 'int24', 32: 'int32' }[format.bits];
    } else if (format.subFormat === 3) {
        encoding = { 32: 'float32', 64: 'float64' }[format.bits];
    }
    if (!encoding || format.blockAlign !== (format.bits / 8) * format.channels) {
        throw new RangedAudioSourceError('This WAV file is compressed. This reader supports uncompressed WAV.');
    }
    const frames = Math.floor(data.size / format.blockAlign);
    const pcm = {
        channels: format.channels,
        encoding,
        littleEndian: true,
        frameBytes: format.blockAlign,
    };
    const labels = labelsFromWaveChannelMask(format.channelMask, format.channels);
    return {
        container: riff === 'RIFF' ? 'wav' : riff.toLowerCase(),
        tracks: [{
            index: 0,
            codec: 'pcm',
            sampleRate: format.sampleRate,
            channels: format.channels,
            bitDepth: format.validBits,
            sampleFormat: encoding,
            labels,
            frames,
            leadFrames: 0,
            reader: pcmChunkReader(blob, pcm, {
                chunkOffsets: Float64Array.of(data.offset),
                chunkFrames: Float64Array.of(frames),
            }),
        }],
        timingWarning: null,
    };
}

// ─── AIFF / AIFC ───────────────────────────────────────────────────────

/** An IEEE 754 80-bit extended float, as AIFF stores its sample rate. */
function extended80(view, at) {
    const exponent = view.getUint16(at) & 0x7fff;
    const hi = view.getUint32(at + 2);
    const lo = view.getUint32(at + 6);
    if (exponent === 0 && hi === 0 && lo === 0) return 0;
    return (hi * 0x100000000 + lo) * 2 ** (exponent - 16383 - 63);
}

async function parseAiff(blob) {
    const head = await readBytes(blob, 0, 12);
    const kind = fourcc(new DataView(head.buffer, head.byteOffset, head.byteLength), 8);
    let format = null;
    let data = null;
    let pos = 12;
    while (pos + 8 <= blob.size && !(format && data)) {
        const header = await readBytes(blob, pos, Math.min(8 + 64, blob.size - pos));
        const v = new DataView(header.buffer, header.byteOffset, header.byteLength);
        const id = fourcc(v, 0);
        const size = v.getUint32(4);
        if (id === 'COMM' && header.length >= 8 + 18) {
            const compression = kind === 'AIFC' && size >= 22 ? fourcc(v, 8 + 18) : 'NONE';
            format = {
                channels: v.getUint16(8),
                frames: v.getUint32(10),
                bits: v.getUint16(14),
                sampleRate: extended80(v, 16),
                compression,
            };
        } else if (id === 'SSND' && header.length >= 16) {
            data = { offset: pos + 16 + v.getUint32(8), size: size - 8 - v.getUint32(8) };
        }
        pos += 8 + size + (size % 2);
    }
    if (!format) throw new RangedAudioSourceError('This AIFF file is incomplete.');
    if (!data) throw new RangedAudioSourceError('This AIFF file has no sound.');
    const integer = { 8: 'int8', 16: 'int16', 24: 'int24', 32: 'int32' }[format.bits];
    const pcm = {
        NONE: integer && { encoding: integer, littleEndian: false },
        twos: integer && { encoding: integer, littleEndian: false },
        sowt: integer && { encoding: integer, littleEndian: true },
        in24: { encoding: 'int24', littleEndian: false },
        in32: { encoding: 'int32', littleEndian: false },
        fl32: { encoding: 'float32', littleEndian: false },
        FL32: { encoding: 'float32', littleEndian: false },
        fl64: { encoding: 'float64', littleEndian: false },
        FL64: { encoding: 'float64', littleEndian: false },
    }[format.compression];
    if (!pcm) throw new RangedAudioSourceError('This AIFF file is compressed. This reader supports uncompressed AIFF.');
    const frameBytes = PCM_WIDTH[pcm.encoding] * format.channels;
    const frames = Math.min(format.frames, Math.floor(Math.max(0, Math.min(data.size, blob.size - data.offset)) / frameBytes));
    return {
        container: kind === 'AIFC' ? 'aifc' : 'aiff',
        tracks: [{
            index: 0,
            codec: 'pcm',
            sampleRate: format.sampleRate,
            channels: format.channels,
            bitDepth: PCM_WIDTH[pcm.encoding] * 8,
            sampleFormat: pcm.encoding,
            labels: null,
            frames,
            leadFrames: 0,
            reader: pcmChunkReader(blob, { ...pcm, channels: format.channels, frameBytes }, {
                chunkOffsets: Float64Array.of(data.offset),
                chunkFrames: Float64Array.of(frames),
            }),
        }],
        timingWarning: null,
    };
}

// ─── ISO BMFF / QuickTime ──────────────────────────────────────────────

// The box types a MOV or MP4 begins with, so anything else (an MXF master, a
// Matroska file) is refused by name rather than misread.
const ISO_TOP_LEVEL_TYPES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid', 'styp']);

async function* topLevelBoxes(blob) {
    let pos = 0;
    while (pos + 8 <= blob.size) {
        const header = await readBytes(blob, pos, Math.min(16, blob.size - pos));
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        let size = view.getUint32(0);
        const type = fourcc(view, 4);
        let headerSize = 8;
        if (size === 1) {
            size = view.getUint32(8) * 0x100000000 + view.getUint32(12);
            headerSize = 16;
        } else if (size === 0) {
            size = blob.size - pos;
        }
        if (size < headerSize) return;
        yield { type, offset: pos, size, headerSize };
        pos += size;
    }
}

function* childBoxes(view, start, end) {
    let pos = start;
    while (pos + 8 <= end) {
        let size = view.getUint32(pos);
        const type = fourcc(view, pos + 4);
        let headerSize = 8;
        if (size === 1) {
            size = view.getUint32(pos + 8) * 0x100000000 + view.getUint32(pos + 12);
            headerSize = 16;
        } else if (size === 0) {
            size = end - pos;
        }
        if (size < headerSize || pos + size > end) return;
        yield { type, offset: pos, size, headerSize, body: pos + headerSize, end: pos + size };
        pos += size;
    }
}

function child(view, box, type) {
    for (const found of childBoxes(view, box.body, box.end)) {
        if (found.type === type) return found;
    }
    return null;
}

function path(view, box, ...types) {
    let current = box;
    for (const type of types) {
        current = current && child(view, current, type);
    }
    return current;
}

const LPCM_FLAG_FLOAT = 0x1;
const LPCM_FLAG_BIG_ENDIAN = 0x2;
const LPCM_FLAG_NON_INTERLEAVED = 0x20;

/** The sound sample entry: codec, rate, channels and how to read the samples. */
function parseSoundEntry(view, entry, { quickTime }) {
    const codec = entry.type;
    const body = entry.body;
    const version = view.getUint16(body + 8);
    let channels = view.getUint16(body + 16);
    let bits = view.getUint16(body + 18);
    let sampleRate = view.getUint32(body + 24) / 65536;
    let extraEnd = body + 28;
    let lpcm = null;
    if (version === 1 && quickTime) {
        // Version 1 adds bytes per sample, which writers keep accurate where
        // the older sample-size field may still say 16.
        const bytesPerSample = view.getUint32(body + 40);
        if (bytesPerSample >= 1 && bytesPerSample <= 4) bits = bytesPerSample * 8;
        extraEnd = body + 44;
    } else if (version === 2) {
        sampleRate = view.getFloat64(body + 32);
        channels = view.getUint32(body + 40);
        bits = view.getUint32(body + 48);
        lpcm = {
            flags: view.getUint32(body + 52),
            bytesPerPacket: view.getUint32(body + 56),
            framesPerPacket: view.getUint32(body + 60),
        };
        extraEnd = body + 64;
    }
    const children = new Map();
    const scanChildren = (start, end) => {
        for (const box of childBoxes(view, start, end)) {
            if (!children.has(box.type)) children.set(box.type, box);
            if (box.type === 'wave') scanChildren(box.body, box.end);
        }
    };
    if (extraEnd < entry.end) scanChildren(extraEnd, entry.end);

    const srat = children.get('srat');
    if (srat) sampleRate = view.getUint32(srat.body + 4);
    const chan = children.get('chan');
    const labels = chan ? labelsFromQuickTimeChan(view, chan.body + 4, chan.end - chan.body - 4, channels) : null;
    const enda = children.get('enda');
    const littleFromEnda = enda ? view.getUint16(enda.body) === 1 : false;

    let pcm = null;
    switch (codec) {
        case 'lpcm': {
            if (!lpcm) break;
            if (lpcm.flags & LPCM_FLAG_NON_INTERLEAVED) {
                throw new RangedAudioSourceError('This file stores its sound in a layout the audio application cannot read.');
            }
            const isFloat = (lpcm.flags & LPCM_FLAG_FLOAT) !== 0;
            const encoding = isFloat ? { 32: 'float32', 64: 'float64' }[bits] : { 8: 'int8', 16: 'int16', 24: 'int24', 32: 'int32' }[bits];
            if (encoding) pcm = { encoding, littleEndian: (lpcm.flags & LPCM_FLAG_BIG_ENDIAN) === 0 };
            break;
        }
        case 'twos':
        case 'sowt':
        case 'NONE':
        case 'raw ': {
            // The sample size names the width: 'twos' and 'sowt' are also
            // written at 24 and 32 bits. Any other size is refused below
            // rather than read as 16-bit.
            const unsigned8 = codec === 'NONE' || codec === 'raw ';
            const encoding = { 8: unsigned8 ? 'int8u' : 'int8', 16: 'int16', 24: 'int24', 32: 'int32' }[bits];
            if (encoding) pcm = { encoding, littleEndian: codec === 'sowt' };
            break;
        }
        case 'in24': pcm = { encoding: 'int24', littleEndian: littleFromEnda }; break;
        case 'in32': pcm = { encoding: 'int32', littleEndian: littleFromEnda }; break;
        case 'fl32': pcm = { encoding: 'float32', littleEndian: littleFromEnda }; break;
        case 'fl64': pcm = { encoding: 'float64', littleEndian: littleFromEnda }; break;
        case 'ipcm':
        case 'fpcm': {
            const pcmC = children.get('pcmC');
            if (!pcmC) break;
            const formatFlags = view.getUint8(pcmC.body + 4);
            const size = view.getUint8(pcmC.body + 5);
            const encoding = codec === 'fpcm'
                ? { 32: 'float32', 64: 'float64' }[size]
                : { 16: 'int16', 24: 'int24', 32: 'int32' }[size];
            if (encoding) pcm = { encoding, littleEndian: (formatFlags & 1) === 1 };
            bits = size;
            break;
        }
        default:
            break;
    }
    if (pcm) {
        pcm.channels = channels;
        pcm.frameBytes = PCM_WIDTH[pcm.encoding] * channels;
        return { kind: 'pcm', codec, sampleRate, channels, bitDepth: PCM_WIDTH[pcm.encoding] * 8, labels, pcm };
    }
    if (codec === 'mp4a') {
        const esds = children.get('esds');
        const config = esds ? audioSpecificConfigFromEsds(view, esds.body + 4, esds.end) : null;
        if (!config) throw new RangedAudioSourceError('This file’s AAC sound is incomplete.');
        return { kind: 'aac', codec, sampleRate, channels, bitDepth: null, labels, description: config.bytes, objectType: config.objectType };
    }
    throw new RangedAudioSourceError('This file’s sound is in a format the browser cannot read. This reader supports uncompressed (PCM) and AAC sound.');
}

function audioSpecificConfigFromEsds(view, start, end) {
    // ES_Descriptor (tag 3) > DecoderConfigDescriptor (tag 4) > DecoderSpecificInfo (tag 5).
    let pos = start;
    const readLength = () => {
        let length = 0;
        for (let i = 0; i < 4 && pos < end; i += 1) {
            const byte = view.getUint8(pos++);
            length = (length << 7) | (byte & 0x7f);
            if ((byte & 0x80) === 0) break;
        }
        return length;
    };
    let objectTypeIndication = null;
    while (pos < end) {
        const tag = view.getUint8(pos++);
        const length = readLength();
        if (tag === 3) {
            const flags = view.getUint8(pos + 2);
            pos += 3;
            if (flags & 0x80) pos += 2;
            if (flags & 0x40) pos += 1 + view.getUint8(pos);
            if (flags & 0x20) pos += 2;
            continue;
        }
        if (tag === 4) {
            objectTypeIndication = view.getUint8(pos);
            pos += 13;
            continue;
        }
        if (tag === 5) {
            const bytes = new Uint8Array(view.buffer, view.byteOffset + pos, length).slice();
            if (objectTypeIndication !== 0x40 && objectTypeIndication !== 0x67) return null;
            return { bytes, objectType: bytes.length ? bytes[0] >> 3 : 2 };
        }
        pos += length;
    }
    return null;
}

/** Chunk offsets, chunk frame counts and per-sample sizes of one track. */
function parseSampleTable(view, stbl) {
    const stsc = child(view, stbl, 'stsc');
    const stco = child(view, stbl, 'stco');
    const co64 = child(view, stbl, 'co64');
    const stsz = child(view, stbl, 'stsz');
    const stts = child(view, stbl, 'stts');
    if (!stsc || (!stco && !co64) || !stsz) {
        throw new RangedAudioSourceError('This file’s sound track is incomplete.');
    }
    const chunkCount = view.getUint32((stco || co64).body + 4);
    const chunkOffsets = new Float64Array(chunkCount);
    for (let i = 0; i < chunkCount; i += 1) {
        chunkOffsets[i] = co64
            ? view.getUint32(co64.body + 8 + i * 8) * 0x100000000 + view.getUint32(co64.body + 12 + i * 8)
            : view.getUint32(stco.body + 8 + i * 4);
    }
    const samplesPerChunk = new Float64Array(chunkCount);
    const entries = view.getUint32(stsc.body + 4);
    for (let e = 0; e < entries; e += 1) {
        const firstChunk = view.getUint32(stsc.body + 8 + e * 12) - 1;
        const perChunk = view.getUint32(stsc.body + 12 + e * 12);
        const nextFirst = e + 1 < entries ? view.getUint32(stsc.body + 8 + (e + 1) * 12) - 1 : chunkCount;
        for (let c = firstChunk; c < Math.min(nextFirst, chunkCount); c += 1) samplesPerChunk[c] = perChunk;
    }
    const defaultSampleSize = view.getUint32(stsz.body + 4);
    const sampleCount = view.getUint32(stsz.body + 8);
    let sampleSizes = null;
    if (defaultSampleSize === 0) {
        sampleSizes = new Uint32Array(sampleCount);
        for (let i = 0; i < sampleCount; i += 1) sampleSizes[i] = view.getUint32(stsz.body + 12 + i * 4);
    }
    let sampleDelta = null;
    if (stts && view.getUint32(stts.body + 4) >= 1) sampleDelta = view.getUint32(stts.body + 12);
    return { chunkOffsets, samplesPerChunk, defaultSampleSize, sampleCount, sampleSizes, sampleDelta };
}

function parseEditList(view, trak, movieTimescale, mediaTimescale, sampleRate) {
    const elst = path(view, trak, 'edts', 'elst');
    if (!elst) return { leadFrames: 0, mediaStartFrame: 0, presentFrames: null, warning: null };
    const version = view.getUint8(elst.body);
    const count = view.getUint32(elst.body + 4);
    const entries = [];
    let pos = elst.body + 8;
    for (let i = 0; i < count; i += 1) {
        const duration = version === 1
            ? view.getUint32(pos) * 0x100000000 + view.getUint32(pos + 4)
            : view.getUint32(pos);
        const mediaTime = version === 1
            ? view.getInt32(pos + 8) * 0x100000000 + view.getUint32(pos + 12)
            : view.getInt32(pos + 4);
        const rate = view.getInt16(pos + (version === 1 ? 16 : 8));
        pos += version === 1 ? 20 : 12;
        entries.push({ duration, mediaTime, rate });
    }
    const toFrames = (movieUnits) => Math.round((movieUnits * sampleRate) / movieTimescale);
    let leadFrames = 0;
    const rest = [...entries];
    while (rest.length && rest[0].mediaTime === -1) leadFrames += toFrames(rest.shift().duration);
    if (rest.length === 0) return { leadFrames, mediaStartFrame: 0, presentFrames: 0, warning: null };
    const main = rest[0];
    const mediaStartFrame = Math.round((main.mediaTime * sampleRate) / mediaTimescale);
    const presentFrames = toFrames(main.duration);
    const warning = rest.length > 1 || main.rate !== 1
        ? 'The sound track is edited in several places; only its first edit is followed.'
        : null;
    return { leadFrames, mediaStartFrame, presentFrames, warning };
}

async function parseIsoBmff(blob) {
    let moovBox = null;
    let brand = '';
    for await (const box of topLevelBoxes(blob)) {
        if (box.type === 'ftyp') {
            const head = await readBytes(blob, box.offset + box.headerSize, 4);
            brand = fourcc(new DataView(head.buffer, head.byteOffset, 4), 0);
        }
        if (box.type === 'moov') {
            moovBox = box;
            break;
        }
    }
    if (!moovBox) throw new RangedAudioSourceError('This file is incomplete: it has no index of its picture and sound.');
    if (moovBox.size > 512 * MIB) throw new RangedAudioSourceError('This file’s index is too large to read in the browser.');
    const moovBytes = typeof blob.pin === 'function'
        ? await blob.pin(moovBox.offset, moovBox.size)
        : await readBytes(blob, moovBox.offset, moovBox.size);
    const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
    const moov = { body: moovBox.headerSize, end: moovBox.size };
    const quickTime = brand === 'qt  ' || brand === '';
    // A movie that may be followed by fragments declares it with mvex
    // (ISO/IEC 14496-12); its sample tables then describe little or none of
    // the sound, so it is refused rather than opened short.
    if (child(view, moov, 'mvex')) {
        throw new RangedAudioSourceError(
            'This file is a fragmented MOV or MP4, whose sound the audio application cannot read a section at a time.',
            { code: 'format' },
        );
    }
    const mvhd = child(view, moov, 'mvhd');
    const movieTimescale = mvhd
        ? view.getUint32(mvhd.body + (view.getUint8(mvhd.body) === 1 ? 20 : 12))
        : 600;

    const tracks = [];
    const refused = [];
    let timingWarning = null;
    let trackIndex = 0;
    for (const trak of childBoxes(view, moov.body, moov.end)) {
        if (trak.type !== 'trak') continue;
        const index = trackIndex++;
        const hdlr = path(view, trak, 'mdia', 'hdlr');
        if (!hdlr || fourcc(view, hdlr.body + 8) !== 'soun') continue;
        const tkhd = child(view, trak, 'tkhd');
        const tkhdVersion = tkhd ? view.getUint8(tkhd.body) : 0;
        const tkhdFlags = tkhd ? view.getUint32(tkhd.body) & 0xffffff : 0x3;
        const mdhd = path(view, trak, 'mdia', 'mdhd');
        const mdhdVersion = mdhd ? view.getUint8(mdhd.body) : 0;
        const mediaTimescale = mdhd ? view.getUint32(mdhd.body + (mdhdVersion === 1 ? 20 : 12)) : 0;
        // Kept for the mono-bed question: FFmpeg enables only the first feed of
        // a six-mono MOV, so a disabled track is still part of the inventory.
        const facts = {
            enabled: (tkhdFlags & 0x1) !== 0,
            inMovie: (tkhdFlags & 0x2) !== 0,
            alternateGroup: tkhd ? view.getUint16(tkhd.body + (tkhdVersion === 1 ? 46 : 34)) : 0,
            languageCode: mdhd ? view.getUint16(mdhd.body + (mdhdVersion === 1 ? 32 : 20)) : null,
        };
        const stbl = path(view, trak, 'mdia', 'minf', 'stbl');
        const stsd = stbl && child(view, stbl, 'stsd');
        if (!stsd || !mediaTimescale) continue;
        const entry = childBoxes(view, stsd.body + 8, stsd.end).next().value;
        if (!entry) continue;
        let sound;
        try {
            sound = parseSoundEntry(view, entry, { quickTime });
        } catch (error) {
            refused.push({ index, reason: error.message });
            continue;
        }
        const table = parseSampleTable(view, stbl);
        const edits = parseEditList(view, trak, movieTimescale, mediaTimescale, sound.sampleRate);
        if (edits.warning) timingWarning = edits.warning;
        const base = {
            index,
            ...facts,
            codec: sound.kind === 'pcm' ? 'pcm' : 'aac',
            sourceCodec: sound.codec,
            sampleEntry: sound.codec,
            sampleRate: sound.sampleRate,
            channels: sound.channels,
            bitDepth: sound.bitDepth,
            sampleFormat: sound.pcm?.encoding || null,
            labels: sound.labels,
            leadFrames: edits.leadFrames,
        };
        if (sound.kind === 'pcm') {
            // Each PCM "sample" in a sound track is one frame of every channel,
            // whatever stsz says (QuickTime writes 1 for version 0 entries).
            const chunkFrames = table.samplesPerChunk;
            let mediaFrames = 0;
            for (let c = 0; c < chunkFrames.length; c += 1) mediaFrames += chunkFrames[c];
            const reader = pcmChunkReader(blob, sound.pcm, { chunkOffsets: table.chunkOffsets, chunkFrames });
            const start = Math.min(edits.mediaStartFrame, mediaFrames);
            const frames = edits.presentFrames === null
                ? mediaFrames - start
                : Math.min(edits.presentFrames, mediaFrames - start);
            tracks.push({ ...base, frames, reader: offsetReader(reader, start) });
        } else {
            const aac = aacReader(blob, sound, table, mediaTimescale);
            const start = Math.min(edits.mediaStartFrame, aac.mediaFrames);
            const frames = edits.presentFrames === null
                ? aac.mediaFrames - start
                : Math.min(edits.presentFrames, aac.mediaFrames - start);
            tracks.push({ ...base, frames, reader: offsetReader(aac.read, start), dispose: aac.dispose });
        }
    }
    if (!tracks.length) {
        throw new RangedAudioSourceError(
            refused.length ? refused[0].reason : 'This file has no sound track the browser can read.',
        );
    }
    return { container: quickTime ? 'mov' : 'mp4', tracks, timingWarning, refused };
}

function offsetReader(read, startFrame) {
    return (frame, count, signal) => read(frame + startFrame, count, signal);
}

/**
 * Read frames [frame, frame + count) of a chunked PCM track as planar Float32.
 * One range per run of adjacent chunks, the picture between them never read.
 */
function pcmChunkReader(blob, pcm, { chunkOffsets, chunkFrames }) {
    const chunkStarts = new Float64Array(chunkFrames.length + 1);
    for (let c = 0; c < chunkFrames.length; c += 1) chunkStarts[c + 1] = chunkStarts[c] + chunkFrames[c];
    const totalFrames = chunkStarts[chunkFrames.length];
    const firstChunkAtOrBefore = (frame) => {
        let lo = 0;
        let hi = chunkFrames.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (chunkStarts[mid] <= frame) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };
    return async (frame, count, signal) => {
        const out = Array.from({ length: pcm.channels }, () => new Float32Array(count));
        const from = Math.max(0, frame);
        const to = Math.min(totalFrames, frame + count);
        if (to <= from) return out;
        let chunk = firstChunkAtOrBefore(from);
        // Gather byte runs over the chunks this read covers.
        const runs = [];
        while (chunk < chunkFrames.length && chunkStarts[chunk] < to) {
            const chunkFrom = Math.max(from, chunkStarts[chunk]);
            const chunkTo = Math.min(to, chunkStarts[chunk + 1]);
            if (chunkTo > chunkFrom) {
                const byteStart = chunkOffsets[chunk] + (chunkFrom - chunkStarts[chunk]) * pcm.frameBytes;
                const byteLength = (chunkTo - chunkFrom) * pcm.frameBytes;
                const last = runs[runs.length - 1];
                if (last && last.byteStart + last.byteLength === byteStart) {
                    last.byteLength += byteLength;
                    last.frames += chunkTo - chunkFrom;
                } else {
                    runs.push({ byteStart, byteLength, outFrame: chunkFrom - frame, frames: chunkTo - chunkFrom });
                }
            }
            chunk += 1;
        }
        const reads = await readRuns(blob, runs.map((run) => ({ start: run.byteStart, length: run.byteLength })), signal);
        runs.forEach((run, i) => {
            decodeInterleavedPcm(reads[i], { ...pcm, frames: run.frames }, out, run.outFrame);
        });
        return out;
    };
}

/**
 * One channel of decoded audio as Float32, converting where the engine will
 * not. The plane is written into `scratch` (grown as needed) rather than a new
 * array per call: a long read decodes thousands of AudioData, and an engine
 * that collects lazily (WebKit) would otherwise hold every copy.
 */
function copyAudioPlane(data, channel, frames, scratch) {
    if (scratch.plane.length < frames) scratch.plane = new Float32Array(frames);
    const plane = scratch.plane.subarray(0, frames);
    try {
        data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
        return plane;
    } catch {
        const channels = data.numberOfChannels;
        if (scratch.interleaved.length < frames * channels) scratch.interleaved = new Float32Array(frames * channels);
        const interleaved = scratch.interleaved.subarray(0, frames * channels);
        data.copyTo(interleaved, { planeIndex: 0, format: 'f32' });
        for (let i = 0; i < frames; i += 1) plane[i] = interleaved[i * channels + channel];
        return plane;
    }
}

/**
 * AAC through WebCodecs. Each read decodes the access units it covers plus two
 * before it, whose output is discarded: an AAC frame overlaps its neighbours,
 * so the first frame after a reset is never the programme's sound.
 *
 * One AudioDecoder serves every read of the track, reset and reconfigured
 * between reads, which run one at a time through it (their byte fetches still
 * overlap). A decoder per read cost WebKit about 2.5 MB each until a garbage
 * collection it rarely ran, so a feature's waveform (about a thousand reads)
 * grew the page by gigabytes.
 */
function aacReader(blob, sound, table, mediaTimescale) {
    const frameSize = table.sampleDelta && mediaTimescale === sound.sampleRate ? table.sampleDelta : 1024;
    const unitCount = table.sampleCount;
    const sizes = table.sampleSizes || new Uint32Array(unitCount).fill(table.defaultSampleSize);
    const offsets = new Float64Array(unitCount);
    let unit = 0;
    for (let c = 0; c < table.chunkOffsets.length && unit < unitCount; c += 1) {
        let offset = table.chunkOffsets[c];
        for (let s = 0; s < table.samplesPerChunk[c] && unit < unitCount; s += 1) {
            offsets[unit] = offset;
            offset += sizes[unit];
            unit += 1;
        }
    }
    const mediaFrames = unitCount * frameSize;
    const PRE_ROLL_UNITS = 2;
    const scratch = { plane: new Float32Array(0), interleaved: new Float32Array(0) };
    let decoder = null;
    let decoded = [];
    let decodeError = null;
    let decodeTurn = Promise.resolve();
    const config = {
        codec: `mp4a.40.${sound.objectType || 2}`,
        sampleRate: sound.sampleRate,
        numberOfChannels: sound.channels,
        description: sound.description,
    };
    const readyDecoder = () => {
        if (!decoder || decoder.state === 'closed') {
            decoder = new globalThis.AudioDecoder({
                output: (data) => decoded.push(data),
                error: (error) => { decodeError = error; },
            });
        } else {
            decoder.reset();
        }
        decoded = [];
        decodeError = null;
        decoder.configure(config);
        return decoder;
    };
    // The decoder is shared, so one read's decode finishes before the next one's starts.
    const takeDecodeTurn = (work) => {
        const turn = decodeTurn.then(work, work);
        decodeTurn = turn.catch(() => {});
        return turn;
    };
    const read = async (frame, count, signal) => {
        const out = Array.from({ length: sound.channels }, () => new Float32Array(count));
        const from = Math.max(0, frame);
        const to = Math.min(mediaFrames, frame + count);
        if (to <= from) return out;
        if (typeof globalThis.AudioDecoder !== 'function') {
            throw new RangedAudioSourceError('This browser cannot decode AAC sound here.', { code: 'decoder' });
        }
        const firstUnit = Math.max(0, Math.floor(from / frameSize) - PRE_ROLL_UNITS);
        const lastUnit = Math.min(unitCount - 1, Math.ceil(to / frameSize));
        const units = [];
        for (let u = firstUnit; u <= lastUnit; u += 1) units.push(u);
        // Access units that sit back to back are fetched as one range.
        const runs = [];
        for (const u of units) {
            const last = runs[runs.length - 1];
            if (last && last.start + last.length === offsets[u]) {
                last.length += sizes[u];
                last.units.push(u);
            } else {
                runs.push({ start: offsets[u], length: sizes[u], units: [u] });
            }
        }
        const runBytes = await readRuns(blob, runs.map(({ start, length }) => ({ start, length })), signal);
        const payloads = [];
        runs.forEach((run, r) => {
            let at = 0;
            for (const u of run.units) {
                payloads.push(runBytes[r].subarray(at, at + sizes[u]));
                at += sizes[u];
            }
        });
        await takeDecodeTurn(async () => {
            const active = readyDecoder();
            units.forEach((u, i) => {
                active.decode(new globalThis.EncodedAudioChunk({
                    type: 'key',
                    timestamp: Math.round((u * frameSize * 1e6) / sound.sampleRate),
                    data: payloads[i],
                }));
            });
            try {
                await active.flush();
            } catch (error) {
                decodeError = decodeError || error;
            }
            const outputs = decoded;
            decoded = [];
            if (decodeError) {
                for (const data of outputs) data.close();
                throw new RangedAudioSourceError('The browser could not decode this file’s AAC sound.');
            }
            for (const data of outputs) {
                // Placed by its own timestamp, not by counting what came before:
                // a decoder may hold back its priming output.
                const cursor = Math.round((data.timestamp * sound.sampleRate) / 1e6);
                const frames = data.numberOfFrames;
                const copyFrom = Math.max(from, cursor);
                const copyTo = Math.min(to, cursor + frames);
                if (copyTo > copyFrom) {
                    for (let ch = 0; ch < sound.channels; ch += 1) {
                        const plane = copyAudioPlane(data, ch, frames, scratch);
                        out[ch].set(plane.subarray(copyFrom - cursor, copyTo - cursor), copyFrom - frame);
                    }
                }
                data.close();
            }
        });
        return out;
    };
    const dispose = () => takeDecodeTurn(() => {
        if (decoder && decoder.state !== 'closed') decoder.close();
        decoder = null;
        for (const data of decoded) data.close();
        decoded = [];
    });
    return { read, mediaFrames, dispose };
}

// ─── The programme ─────────────────────────────────────────────────────

/**
 * Open a programme's sound. `trackIndexes` picks the container tracks to read
 * as one programme, their channels in that order; by default the programme
 * track alone (the first enabled sound track, else the first readable one).
 */
export async function openRangedAudioSource(blob, { trackIndexes = null } = {}) {
    const head = await readBytes(blob, 0, Math.min(blob.size, 12));
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const magic = head.length >= 4 ? fourcc(view, 0) : '';
    const form = head.length >= 12 ? fourcc(view, 8) : '';
    let parsed;
    if (['RIFF', 'RF64', 'BW64'].includes(magic) && form === 'WAVE') {
        parsed = await parseWave(blob);
    } else if (magic === 'FORM' && (form === 'AIFF' || form === 'AIFC')) {
        parsed = await parseAiff(blob);
    } else if (head.length >= 8 && ISO_TOP_LEVEL_TYPES.has(fourcc(view, 4))) {
        parsed = await parseIsoBmff(blob);
    } else {
        throw new RangedAudioSourceError(
            'This reader supports the sound of MOV, MP4, WAV and AIFF files. This file is another kind.',
            { code: 'format' },
        );
    }
    const available = parsed.tracks;
    const programmeTrack = available.find((t) => t.enabled !== false) || available[0];
    const chosen = trackIndexes
        ? trackIndexes.map((i) => available.find((t) => t.index === i)).filter(Boolean)
        : [programmeTrack];
    if (trackIndexes && chosen.length !== trackIndexes.length) {
        throw new RangedAudioSourceError('One of the chosen sound tracks cannot be read.');
    }
    if (!chosen.length) throw new RangedAudioSourceError('None of the chosen sound tracks can be read.');
    if (chosen.some((t) => t.sampleRate !== chosen[0].sampleRate)) {
        throw new RangedAudioSourceError('The chosen sound tracks run at different sample rates.');
    }
    const channels = chosen.reduce((sum, t) => sum + t.channels, 0);
    if (channels > MAX_PROGRAMME_CHANNELS) {
        throw new RangedAudioSourceError(`This programme has ${channels} channels; the reader supports up to ${MAX_PROGRAMME_CHANNELS}.`);
    }
    const sampleRate = chosen[0].sampleRate;
    const frames = Math.max(...chosen.map((t) => t.leadFrames + t.frames));
    // Mono tracks read as one bed carry one label each, so the side and rear
    // pairs are told apart across the whole bed, not within a track.
    const labels = chosen.every((t) => t.labels) ? resolveSurroundPairs(chosen.flatMap((t) => t.labels)) : null;

    let closed = false;
    const pendingReads = new Set();
    /** Frames [frame, frame + count) of every chosen channel, as planar Float32. */
    async function read(frame, count, signal) {
        if (closed) throw new Error('Audio source is closed.');
        if (!Number.isSafeInteger(frame) || !Number.isSafeInteger(count) || count < 0) throw new RangeError('Frame and count must be safe integers; count must be non-negative.');
        if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
        // Every track at once: a multi-mono master's feeds are separate chunk
        // runs, and reading them one after another would multiply the wait.
        const perTrack = await Promise.all(chosen.map(async (track) => {
            // The track's own frame at the start of this read; before its lead
            // and after its end the programme is silence.
            const local = frame - track.leadFrames;
            const planes = Array.from({ length: track.channels }, () => new Float32Array(count));
            const readFrom = Math.max(0, local);
            const readTo = Math.min(track.frames, local + count);
            if (readTo > readFrom) {
                const got = await track.reader(readFrom, readTo - readFrom, signal);
                for (let ch = 0; ch < track.channels; ch += 1) planes[ch].set(got[ch], readFrom - local);
            }
            return planes;
        }));
        return perTrack.flat();
    }

    return {
        container: parsed.container,
        sampleRate,
        channels,
        frames,
        durationSeconds: frames / sampleRate,
        labels,
        bitDepth: Math.max(...chosen.map((t) => t.bitDepth || 0)) || null,
        tracks: available.map(({ reader, dispose, ...facts }) => facts),
        chosenTrackIndexes: chosen.map((t) => t.index),
        timingWarning: parsed.timingWarning,
        read(...args) {
            const pending = read(...args);
            pendingReads.add(pending);
            pending.then(() => pendingReads.delete(pending), () => pendingReads.delete(pending));
            return pending;
        },
        async close() {
            if (closed) return;
            closed = true;
            await Promise.allSettled([...pendingReads]);
            await Promise.all(chosen.map((track) => track.dispose?.()));
        },
    };
}
