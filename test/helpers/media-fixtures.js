// Byte-level media fixtures for the audio application's streaming tests: PCM in
// every width and order, WAV/RF64 files, and QuickTime/ISO movies whose sound
// is threaded between picture chunks the way a film master's is.
// A deterministic, distinct value per channel and frame, exactly representable
// at 16 bits so every encoding round-trips it.
export const valueAt = (channel, frame) => (((frame * 7 + channel * 1013) % 2000) - 1000) / 32768;

function encodeSample(view, at, value, encoding, littleEndian) {
  switch (encoding) {
    case "int16":
      view.setInt16(at, Math.round(value * 32768), littleEndian);
      break;
    case "int24": {
      let int = Math.round(value * 8388608);
      if (int < 0) int += 0x1000000;
      const bytes = [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
      if (littleEndian) bytes.reverse();
      bytes.forEach((byte, i) => view.setUint8(at + i, byte));
      break;
    }
    case "int32":
      view.setInt32(at, Math.round(value * 2147483648), littleEndian);
      break;
    case "float32":
      view.setFloat32(at, value, littleEndian);
      break;
    default:
      throw new Error(encoding);
  }
}

const WIDTH = { int16: 2, int24: 3, int32: 4, float32: 4 };

export function pcmBytes({ channels, frames, firstFrame = 0, encoding, littleEndian, channelOffset = 0 }) {
  const width = WIDTH[encoding];
  const bytes = new Uint8Array(frames * channels * width);
  const view = new DataView(bytes.buffer);
  for (let f = 0; f < frames; f += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      encodeSample(view, (f * channels + ch) * width, valueAt(ch + channelOffset, firstFrame + f), encoding, littleEndian);
    }
  }
  return bytes;
}

export function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const u32 = (value) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value);
  return b;
};
export const u16 = (value) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value);
  return b;
};
const i32 = (value) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value);
  return b;
};
const f64 = (value) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value);
  return b;
};
export const ascii = (text) => new TextEncoder().encode(text);
export const box = (type, ...payload) => {
  const body = concat(payload);
  return concat([u32(body.length + 8), ascii(type), body]);
};
const fullBox = (type, version, flags, ...payload) =>
  box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...payload);

export function waveFile({ channels, frames, encoding = "int24", rf64 = false, channelMask = 0 }) {
  const width = WIDTH[encoding];
  const data = pcmBytes({ channels, frames, encoding, littleEndian: true });
  const le32 = (v) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return b;
  };
  const le16 = (v) => {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    return b;
  };
  const extensible = channelMask !== 0;
  const fmtBody = concat([
    le16(extensible ? 0xfffe : encoding === "float32" ? 3 : 1),
    le16(channels),
    le32(48000),
    le32(48000 * channels * width),
    le16(channels * width),
    le16(width * 8),
    ...(extensible
      ? [le16(22), le16(width * 8), le32(channelMask), le16(encoding === "float32" ? 3 : 1), new Uint8Array(14)]
      : []),
  ]);
  const chunk = (id, body, sizeOverride) => concat([ascii(id), le32(sizeOverride ?? body.length), body]);
  const ds64 = rf64
    ? [chunk("ds64", concat([le32(0), le32(0), le32(data.length), le32(0), le32(frames), le32(0), le32(0)]))]
    : [];
  const chunks = concat([...ds64, chunk("fmt ", fmtBody), chunk("data", data, rf64 ? 0xffffffff : undefined)]);
  return concat([ascii(rf64 ? "RF64" : "RIFF"), le32(rf64 ? 0xffffffff : chunks.length + 4), ascii("WAVE"), chunks]);
}

/**
 * A QuickTime movie: a picture track whose 'frames' are filler bytes, and one
 * or more sound tracks, their chunks interleaved with picture chunks in the
 * mdat the way an editor writes a master.
 */
export function quickTimeMovie({ soundTracks, chunkFrames = 4800, totalFrames, pictureChunkBytes = 3000, brand = "qt  ", moovExtra = [] }) {
  const chunkCount = Math.ceil(totalFrames / chunkFrames);
  const parts = [];
  const ftyp = box("ftyp", ascii(brand), u32(0), ascii(brand));
  let cursor = ftyp.length + 8; // mdat header
  const offsets = soundTracks.map(() => []);
  const pictureOffsets = [];
  for (let c = 0; c < chunkCount; c += 1) {
    const frames = Math.min(chunkFrames, totalFrames - c * chunkFrames);
    pictureOffsets.push(cursor);
    const picture = new Uint8Array(pictureChunkBytes).fill(0xee);
    parts.push(picture);
    cursor += picture.length;
    soundTracks.forEach((track, t) => {
      offsets[t].push(cursor);
      const bytes = pcmBytes({
        channels: track.channels,
        frames,
        firstFrame: c * chunkFrames,
        encoding: track.encoding,
        littleEndian: track.littleEndian,
        channelOffset: track.channelOffset || 0,
      });
      parts.push(bytes);
      cursor += bytes.length;
    });
  }
  const mdatBody = concat(parts);
  const mdat = concat([u32(mdatBody.length + 8), ascii("mdat"), mdatBody]);
  const stco = (list) => fullBox("stco", 0, 0, u32(list.length), ...list.map((o) => u32(o)));
  const stsc = (list) => {
    const last = totalFrames - (list.length - 1) * chunkFrames;
    const entries = last === chunkFrames ? [[1, chunkFrames]] : [[1, chunkFrames], [list.length, last]];
    return fullBox("stsc", 0, 0, u32(entries.length), ...entries.flatMap(([first, per]) => [u32(first), u32(per), u32(1)]));
  };
  const hdlr = (type) => fullBox("hdlr", 0, 0, u32(0), ascii(type), new Uint8Array(12), new Uint8Array([0]));
  const mdhd = (timescale, duration) => fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0), u16(0));
  const tkhd = (enabled) => fullBox("tkhd", 0, enabled ? 3 : 2, new Uint8Array(80));
  const pictureTrak = box(
    "trak",
    tkhd(true),
    box(
      "mdia",
      mdhd(24, 10),
      hdlr("vide"),
      box("minf", box("stbl", fullBox("stsd", 0, 0, u32(1), box("avc1", new Uint8Array(78))), stco(pictureOffsets))),
    ),
  );
  const soundTraks = soundTracks.map((track, t) => {
    const entry = track.entry(track);
    const stsz = fullBox("stsz", 0, 0, u32(track.stszSize ?? 1), u32(totalFrames));
    const stts = fullBox("stts", 0, 0, u32(1), u32(totalFrames), u32(1));
    const edts = track.edits
      ? box("edts", fullBox("elst", 0, 0, u32(track.edits.length), ...track.edits.flatMap((e) => [u32(e.duration), i32(e.mediaTime), u16(1), u16(0)])))
      : new Uint8Array(0);
    return box(
      "trak",
      tkhd(track.enabled !== false),
      edts,
      box(
        "mdia",
        mdhd(48000, totalFrames),
        hdlr("soun"),
        box("minf", box("stbl", fullBox("stsd", 0, 0, u32(1), entry), stts, stsc(offsets[t]), stsz, stco(offsets[t]))),
      ),
    );
  });
  const mvhd = fullBox("mvhd", 0, 0, u32(0), u32(0), u32(600), u32(0), new Uint8Array(80));
  const moov = box("moov", mvhd, ...moovExtra, pictureTrak, ...soundTraks);
  const movie = concat([ftyp, mdat, moov]);
  // Where the picture is, so a test can prove nothing ever read it.
  movie.pictureChunks = pictureOffsets.map((offset) => [offset, offset + pictureChunkBytes]);
  return movie;
}

// QuickTime sound sample entries.
export const qtV0 = (type, extra = []) => (track) =>
  box(type, new Uint8Array(6), u16(1), u16(0), u16(0), u32(0), u16(track.channels), u16(WIDTH[track.encoding] * 8), u16(0), u16(0), u32(48000 * 65536), ...extra);
export const qtV2Lpcm = (flags) => (track) =>
  box(
    "lpcm",
    new Uint8Array(6), u16(1), u16(2), u16(0), u32(0),
    u16(3), u16(16), u16(0xfffe), u16(0), u32(65536),
    u32(72), f64(48000), u32(track.channels), u32(0x7f000000), u32(WIDTH[track.encoding] * 8), u32(flags),
    u32(WIDTH[track.encoding] * track.channels), u32(1),
  );
export const isoIpcm = (track) =>
  box(
    "ipcm",
    new Uint8Array(6), u16(1), new Uint8Array(8), u16(track.channels), u16(WIDTH[track.encoding] * 8), u16(0), u16(0), u32(48000 * 65536),
    fullBox("pcmC", 0, 0, new Uint8Array([track.littleEndian ? 1 : 0, WIDTH[track.encoding] * 8])),
  );

export const asFile = (bytes) => new Blob([bytes]);
