import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';

export interface StudioMediaVideoInfo {
  codec: string | null;
  width: number;
  height: number;
  rotation: number;
  decodable: boolean;
}

export interface StudioMediaAudioInfo {
  codec: string | null;
  sampleRate: number;
  channels: number;
  decodable: boolean;
}

export interface StudioMediaProbeResult {
  mimeType: string;
  format: string;
  durationMs: number | null;
  video: StudioMediaVideoInfo | null;
  audio: StudioMediaAudioInfo | null;
}

export async function probeStudioMedia(filePath: string): Promise<StudioMediaProbeResult> {
  const input = new Input({
    source: new FilePathSource(filePath, { maxCacheSize: 8 * 1024 * 1024 }),
    formats: ALL_FORMATS,
  });
  try {
    if (!await input.canRead()) {
      throw new Error('Unsupported or unreadable media format.');
    }
    const [format, mimeType, durationSeconds, videoTrack, audioTrack] = await Promise.all([
      input.getFormat(),
      input.getMimeType(),
      input.getDurationFromMetadata(undefined, { skipLiveWait: true }),
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    const [video, audio] = await Promise.all([
      videoTrack
        ? Promise.all([
          videoTrack.getCodec(),
          videoTrack.getDisplayWidth(),
          videoTrack.getDisplayHeight(),
          videoTrack.getRotation(),
          videoTrack.canDecode(),
        ]).then(([codec, width, height, rotation, decodable]) => ({
          codec,
          width,
          height,
          rotation,
          decodable,
        }))
        : Promise.resolve(null),
      audioTrack
        ? Promise.all([
          audioTrack.getCodec(),
          audioTrack.getSampleRate(),
          audioTrack.getNumberOfChannels(),
          audioTrack.canDecode(),
        ]).then(([codec, sampleRate, channels, decodable]) => ({
          codec,
          sampleRate,
          channels,
          decodable,
        }))
        : Promise.resolve(null),
    ]);
    return {
      mimeType,
      format: format.constructor.name,
      durationMs: durationSeconds === null ? null : Math.max(0, Math.round(durationSeconds * 1000)),
      video,
      audio,
    };
  } finally {
    input.dispose();
  }
}
