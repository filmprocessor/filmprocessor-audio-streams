// A WAV written a section at a time, for a mix too long to hold in memory.
//
// The header is written first with a JUNK chunk reserving the room a ds64
// chunk needs (EBU Tech 3306), the sound follows in order, and `finish()`
// goes back to fill in the sizes: an ordinary RIFF/WAVE when the file fits in
// 4 GiB, otherwise RF64 with the JUNK chunk turned into ds64. The sink is any
// object with `write(bytes, position)`; an OPFS writable stream is one.

const FORMAT_EXTENSIBLE = 0xfffe;
const PCM_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
const RIFF_LIMIT = 0xffffffff;

function le16(view, at, value) { view.setUint16(at, value, true); }
function le32(view, at, value) { view.setUint32(at, value >>> 0, true); }
function le64(view, at, value) {
    view.setUint32(at, value % 0x100000000, true);
    view.setUint32(at + 4, Math.floor(value / 0x100000000), true);
}
function ascii(view, at, text) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
}

function chunk(id, body) {
    const padded = body.length + (body.length % 2);
    const bytes = new Uint8Array(8 + padded);
    const view = new DataView(bytes.buffer);
    ascii(view, 0, id);
    le32(view, 4, body.length);
    bytes.set(body, 8);
    return bytes;
}

function fmtBody({ sampleRate, channels, bitDepth, float, channelMask }) {
    const bytes = new Uint8Array(40);
    const view = new DataView(bytes.buffer);
    const blockAlign = channels * (bitDepth / 8);
    le16(view, 0, FORMAT_EXTENSIBLE);
    le16(view, 2, channels);
    le32(view, 4, sampleRate);
    le32(view, 8, sampleRate * blockAlign);
    le16(view, 12, blockAlign);
    le16(view, 14, bitDepth);
    le16(view, 16, 22);
    le16(view, 18, bitDepth);
    le32(view, 20, channelMask);
    le16(view, 24, float ? 3 : 1);
    bytes.set(PCM_GUID_TAIL, 26);
    return bytes;
}

/**
 * Interleave planar Float32 into little-endian PCM. Integer output is clipped
 * to full scale and scaled exactly as the audio application's whole-file writer
 * (bufferToWave) scales it, with no dither, so a section of a long render and
 * the same moment of a short one are written as the same bytes.
 */
export function encodePcm(planes, frames, bitDepth, float = false) {
    const channels = planes.length;
    const width = bitDepth / 8;
    const out = new Uint8Array(frames * channels * width);
    const view = new DataView(out.buffer);
    let at = 0;
    for (let f = 0; f < frames; f += 1) {
        for (let ch = 0; ch < channels; ch += 1) {
            const raw = planes[ch][f] || 0;
            if (float) {
                view.setFloat32(at, raw, true);
                at += width;
                continue;
            }
            const sample = Math.max(-1, Math.min(1, raw));
            if (bitDepth === 16) {
                view.setInt16(at, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
            } else if (bitDepth === 24) {
                const int = sample < 0 ? Math.floor(sample * 0x800000) : Math.floor(sample * 0x7fffff);
                out[at] = int & 0xff;
                out[at + 1] = (int >> 8) & 0xff;
                out[at + 2] = (int >> 16) & 0xff;
            } else {
                view.setInt32(at, sample < 0 ? Math.floor(sample * 0x80000000) : Math.floor(sample * 0x7fffffff), true);
            }
            at += width;
        }
    }
    return out;
}

export class StreamingWaveWriter {
    /**
     * @param {{ write(bytes: Uint8Array, position: number): Promise<void> }} sink
     * @param {{ sampleRate: number, channels: number, bitDepth?: 16|24|32,
     *   float?: boolean, channelMask?: number, extraChunks?: Uint8Array[] }} format
     *   `channelMask` is the WAVE_FORMAT_EXTENSIBLE speaker mask for the
     *   channels in the order they are written; the audio application's export channel
     *   plan decides both (7.1 is cinema order under the 7.1 mask). `extraChunks`
     *   are complete chunks (bext, iXML, LIST) written before the sound.
     */
    constructor(sink, { sampleRate, channels, bitDepth = 24, float = false, channelMask = 0, extraChunks = [] }) {
        if (![16, 24, 32].includes(bitDepth) || (float && bitDepth !== 32)) {
            throw new Error('A WAV is written at 16, 24 or 32 bits, or 32-bit float.');
        }
        if (!Number.isInteger(channels) || channels < 1 || channels > 64) throw new Error('Channel count is invalid.');
        this.sink = sink;
        this.format = { sampleRate, channels, bitDepth, float };
        this.channelMask = channelMask >>> 0;
        this.extraChunks = extraChunks;
        this.frames = 0;
        this.dataBytes = 0;
        this.position = 0;
        this.headerLength = 0;
        this.junkOffset = 12;
        this.finished = false;
    }

    async begin() {
        const fmt = chunk('fmt ', fmtBody({ ...this.format, channelMask: this.channelMask }));
        const junk = chunk('JUNK', new Uint8Array(28));
        const head = new Uint8Array(12);
        const view = new DataView(head.buffer);
        ascii(view, 0, 'RIFF');
        ascii(view, 8, 'WAVE');
        const dataHeader = new Uint8Array(8);
        ascii(new DataView(dataHeader.buffer), 0, 'data');
        const parts = [head, junk, fmt, ...this.extraChunks, dataHeader];
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const part of parts) {
            bytes.set(part, at);
            at += part.length;
        }
        this.headerLength = total;
        this.dataSizeOffset = total - 4;
        await this.sink.write(bytes, 0);
        this.position = total;
    }

    /** Append planar Float32 frames, every plane the same length. */
    async writeFrames(planes, frames = planes[0]?.length || 0) {
        if (this.finished) throw new Error('This WAV is already finished.');
        if (planes.length !== this.format.channels) throw new Error('Channel count changed mid-file.');
        if (frames <= 0) return;
        const bytes = encodePcm(planes, frames, this.format.bitDepth, this.format.float);
        await this.sink.write(bytes, this.position);
        this.position += bytes.length;
        this.dataBytes += bytes.length;
        this.frames += frames;
    }

    /** Fill in the sizes. Returns what was written. */
    async finish() {
        if (this.finished) throw new Error('This WAV is already finished.');
        this.finished = true;
        const padding = this.dataBytes % 2;
        if (padding) {
            await this.sink.write(new Uint8Array(1), this.position);
            this.position += 1;
        }
        const fileBytes = this.position;
        const riffSize = fileBytes - 8;
        const rf64 = riffSize > RIFF_LIMIT || this.dataBytes > RIFF_LIMIT;
        const head = new Uint8Array(8);
        const headView = new DataView(head.buffer);
        ascii(headView, 0, rf64 ? 'RF64' : 'RIFF');
        le32(headView, 4, rf64 ? RIFF_LIMIT : riffSize);
        await this.sink.write(head, 0);
        if (rf64) {
            const ds64 = new Uint8Array(36);
            const view = new DataView(ds64.buffer);
            ascii(view, 0, 'ds64');
            le32(view, 4, 28);
            le64(view, 8, riffSize);
            le64(view, 16, this.dataBytes);
            le64(view, 24, this.frames);
            le32(view, 32, 0);
            await this.sink.write(ds64, this.junkOffset);
        }
        const size = new Uint8Array(4);
        le32(new DataView(size.buffer), 0, rf64 ? RIFF_LIMIT : this.dataBytes);
        await this.sink.write(size, this.dataSizeOffset);
        return { frames: this.frames, dataBytes: this.dataBytes, fileBytes, rf64 };
    }
}

/** A sink over an OPFS writable (`FileSystemWritableFileStream`). */
export function opfsWritableSink(writable) {
    return {
        write: (bytes, position) => writable.write({ type: 'write', position, data: bytes }),
        close: () => writable.close(),
        abort: () => writable.abort?.(),
    };
}

/** A sink into memory, for tests and short renders. */
export function memorySink() {
    let bytes = new Uint8Array(0);
    return {
        async write(data, position) {
            const end = position + data.length;
            if (end > bytes.length) {
                const grown = new Uint8Array(Math.max(end, bytes.length * 2));
                grown.set(bytes);
                bytes = grown;
                this.length = Math.max(this.length || 0, end);
            }
            bytes.set(data, position);
            this.length = Math.max(this.length || 0, end);
        },
        bytes() {
            return bytes.subarray(0, this.length || 0);
        },
        length: 0,
    };
}
