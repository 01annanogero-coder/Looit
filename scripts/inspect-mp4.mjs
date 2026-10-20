// Prints the container/codec details of an exported MP4 (used to verify exports).
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';

const file = process.argv[2] ?? 'selftest-out/export.mp4';
const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
const stats = await track.computePacketStats();
console.log({
  format: (await input.getFormat()).name,
  codec: await track.getCodecParameterString(),
  width: track.displayWidth,
  height: track.displayHeight,
  durationSeconds: await input.computeDuration(),
  frames: stats.packetCount,
  fps: Number(stats.averagePacketRate.toFixed(3)),
  bitrateKbps: Math.round(stats.averageBitrate / 1000),
});
