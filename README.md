# FilmProcessor Audio Streams

Read and process audio a section at a time. Dependency-free ES modules for
browsers and Node.js 20+. PCM reading, waveform generation, sample-rate conversion
and WAV/RF64 writing work without playing sound.

## Use

Clone this repository and import `src/index.js`. It is not published to npm.

```js
import { openRangedAudioSource, streamWaveformPeaks } from './src/index.js';
const source = await openRangedAudioSource(file); // File or Blob
const { envelope } = await streamWaveformPeaks({
  readSection: (start, count) => source.read(start, count),
  totalFrames: source.frames,
  sampleRate: source.sampleRate,
  channels: source.channels,
  columns: 1000,
  sectionSeconds: 2,
});
// envelope[channel][column] contains {min, max}.
```

The reader supports PCM WAV/BWF/RF64/BW64, AIFF/AIFC and PCM or AAC tracks in
non-fragmented MOV/MP4. AAC requires a compatible WebCodecs `AudioDecoder`;
Node PCM use needs no decoder dependency. The default selects the first enabled
audio track. Pass `{trackIndexes: [...]}` to explicitly combine tracks.

`source.read(startFrame, count, signal)` returns planar Float32 arrays; areas
outside the programme are silence. Read manageable sections: allocation grows
with the requested frame count and channel count, up to 32 channels.
Container indexes also occupy memory, so memory is not constant for every file.
Call `await source.close()` when finished to release any AAC decoder.

## Other APIs

- `streamWaveformPeaks`: sampled overview, then exact full-pass min/max columns.
  The overview is approximate; only the completed full pass covers every sample.
- `createResamplingKernel`, `inputSpanFor`, `resampleInto`, `resamplingSource`:
  windowed-sinc conversion whose independently requested sections align.
- `StreamingWaveWriter`: write PCM sections to an injected seekable sink and
  finalize as WAV or RF64. Call `begin()`, then `writeFrames(planes)` in order,
  then `finish()` to fill the final sizes.
- `opfsWritableSink`, `memorySink`: sink adapters. The memory sink retains the
  complete result and is intended for small files and tests.
- `decodeInterleavedPcm`, `labelsFromWaveChannelMask`: PCM and channel metadata helpers.

An injected byte source can implement `size` and `read(start, length, signal)`,
optionally `readMany(runs, signal)`. It must return the requested bytes.
Network authentication, retry policies, storage services and spatial rendering
are supplied by the application and are not included.

## Validation and licence

Run `npm test` or `node examples/roundtrip.js`. Tests use generated PCM, WAV,
RF64, AIFF and MOV files, analytic tones and a mocked AAC decoder. They cover
chunk boundaries, timing offsets, waveform accuracy, cancellation, resampling
and output above 4 GiB without allocating a 4 GiB test file.

AAC interoperability depends on the browser's decoder. This package does not
claim support for every QuickTime layout, compressed codec or edit list.

MIT; see `LICENSE` and `NOTICE`.
