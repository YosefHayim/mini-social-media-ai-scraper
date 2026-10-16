import { Effect, Schema } from 'effect';
import { rm } from 'node:fs/promises';
import path from 'node:path';

import { fetchPlayerPayloadFromPlayerApi } from './player-api.js';
import { fetchTextResourceOptional } from './http.js';
import { extractEmbeddedJson } from './parsing.js';
import { downloadMediaToFile } from './media-download.js';
import { requireFfmpeg, runFfmpeg } from './ffmpeg.js';
import { logInfo, logWarn } from './log.js';

import { CONSTANTS } from './constants.js';

const {
  BROWSER_USER_AGENT,
  YOUTUBE_ORIGIN_SLASH: DEFAULT_REFERRER_URL,
  YOUTUBE_INITIAL_PLAYER_RESPONSE_MARKER,
} = CONSTANTS.shared;
const { USER_AGENT_HEADER, REFERER_HEADER } = CONSTANTS.http;
const {
  LOG_VIDEO_DOWNLOAD_START,
  LOG_VIDEO_SAVED_TEMPLATE,
  LOG_VIDEO_MUXING,
  LOG_VIDEO_MUX_TEMPLATE,
  LOG_VIDEO_NO_FORMATS,
  LOG_WATCH_HTML_SKIPPED,
} = CONSTANTS.main;
const {
  MIME_AUDIO_PREFIX,
  MIME_MP4_MARK,
  MEDIA_EXTENSION_MP4,
  MEDIA_EXTENSION_PART_VIDEO,
  MEDIA_EXTENSION_PART_AUDIO,
} = CONSTANTS.video;

// One media stream advertised by YouTube streamingData.
export type StreamingFormat = {
  // Format itag when YouTube labels the stream.
  itag: number | null;
  // Direct media URL; null when the stream needs signature deciphering.
  url: string | null;
  // MIME container family (`mp4`, `webm`, `m4a`, …).
  container: string | null;
  // Stream payload: combined audio+video, video-only, or audio-only.
  streamKind: 'video-audio' | 'video' | 'audio';
  // Codecs attribute such as `avc1.640028` when the stream declares it.
  codecs: string | null;
  // Vertical resolution in pixels for video streams.
  height: number | null;
  // Encoding bitrate in bits per second.
  bitrate: number | null;
  // Declared byte length when the server exposes it.
  contentLength: number | null;
};

const EMPTY_STREAM_NODES = [] as const;

const streamingFormatNodeSchema = Schema.Struct({
  // Numeric itag identifier when the stream is labeled.
  itag: Schema.optional(Schema.Number),
  // Direct playable URL; absent for signature-ciphered streams.
  url: Schema.optional(Schema.String),
  // Media MIME descriptor such as `video/mp4; codecs=…`.
  mimeType: Schema.optional(Schema.String),
  // Vertical resolution in pixels for video streams.
  height: Schema.optional(Schema.Number),
  // Encoding bitrate in bits per second.
  bitrate: Schema.optional(Schema.Number),
  // Declared byte length (string from YouTube, number from JSON).
  contentLength: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
});

const streamingDataSchema = Schema.Struct({
  // Progressive combined audio+video formats.
  formats: Schema.optionalWith(Schema.Array(streamingFormatNodeSchema), {
    default: () => EMPTY_STREAM_NODES,
  }),
  // Adaptive separate video-only / audio-only streams.
  adaptiveFormats: Schema.optionalWith(Schema.Array(streamingFormatNodeSchema), {
    default: () => EMPTY_STREAM_NODES,
  }),
});

const playerStreamsPayloadSchema = Schema.Struct({
  // Media stream container; absent when the client has no playable set.
  streamingData: Schema.optionalWith(streamingDataSchema, {
    default: () => ({ formats: EMPTY_STREAM_NODES, adaptiveFormats: EMPTY_STREAM_NODES }),
  }),
});

const decodeStreamsPayload = Schema.decodeUnknown(playerStreamsPayloadSchema);

type PlayerStreamsPayload = Schema.Schema.Type<typeof playerStreamsPayloadSchema>;
type StreamingFormatNode = Schema.Schema.Type<typeof streamingFormatNodeSchema>;

const tryDecodeStreamsPayload = (playerPayload: unknown): PlayerStreamsPayload | null => {
  try {
    return Effect.runSync(decodeStreamsPayload(playerPayload));
  } catch {
    return null;
  }
};

const parseContentLength = (contentLengthValue: number | string | undefined): number | null => {
  if (contentLengthValue === undefined) {
    return null;
  }
  const parsedLength = Number(contentLengthValue);
  return Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : null;
};

const containerFromMimeType = (mimeType: string | null): string | null => {
  if (!mimeType) {
    return null;
  }
  const containerToken = mimeType.split('/')[1]?.split(';')[0]?.trim();
  return containerToken && containerToken.length > 0 ? containerToken : null;
};

const codecsFromMimeType = (mimeType: string | null): string | null => {
  if (!mimeType) {
    return null;
  }
  const codecsParameter = mimeType
    .split(';')
    .map((parameterToken) => parameterToken.trim())
    .find((parameterToken) => parameterToken.startsWith('codecs='));
  if (!codecsParameter) {
    return null;
  }
  const codecsToken = codecsParameter.slice('codecs='.length).replace(/^"|"$/g, '');
  return codecsToken.length > 0 ? codecsToken : null;
};

const streamKindFromMimeType = (
  mimeType: string | null,
  isProgressive: boolean,
): StreamingFormat['streamKind'] => {
  if (isProgressive) {
    return 'video-audio';
  }
  if (mimeType && mimeType.startsWith(MIME_AUDIO_PREFIX)) {
    return 'audio';
  }
  return 'video';
};

const parseStreamFormatNodes = (
  formatNodes: readonly StreamingFormatNode[],
  isProgressive: boolean,
): StreamingFormat[] => {
  const streamingFormats: StreamingFormat[] = [];
  for (const formatNode of formatNodes) {
    const mimeType = formatNode.mimeType ?? null;
    streamingFormats.push({
      itag: formatNode.itag ?? null,
      url: formatNode.url ?? null,
      container: containerFromMimeType(mimeType),
      streamKind: streamKindFromMimeType(mimeType, isProgressive),
      codecs: codecsFromMimeType(mimeType),
      height: formatNode.height ?? null,
      bitrate: formatNode.bitrate ?? null,
      contentLength: parseContentLength(formatNode.contentLength),
    });
  }
  return streamingFormats;
};

export const parseStreamingFormatsFromPayload = (playerPayload: unknown): StreamingFormat[] => {
  const decodedPayload = tryDecodeStreamsPayload(playerPayload);
  if (!decodedPayload) {
    return [];
  }
  return [
    ...parseStreamFormatNodes(decodedPayload.streamingData.formats, true),
    ...parseStreamFormatNodes(decodedPayload.streamingData.adaptiveFormats, false),
  ];
};

const sortByHeightAndBitrate = (leftFormat: StreamingFormat, rightFormat: StreamingFormat): number => {
  const heightDelta = (rightFormat.height ?? -1) - (leftFormat.height ?? -1);
  if (heightDelta !== 0) {
    return heightDelta;
  }
  return (rightFormat.bitrate ?? 0) - (leftFormat.bitrate ?? 0);
};

const isH264Codec = (codecsValue: string | null): boolean => {
  // H.264 (avc1) is broadly playable in system players; prefer it over AV1/VP9.
  return codecsValue !== null && codecsValue.toLowerCase().startsWith('avc');
};

const sortVideoStreamsForQuality = (
  leftFormat: StreamingFormat,
  rightFormat: StreamingFormat,
): number => {
  // Highest resolution first; H.264 preferred over newer codecs for system-player support.
  const h264Delta = (isH264Codec(rightFormat.codecs) ? 1 : 0) - (isH264Codec(leftFormat.codecs) ? 1 : 0);
  if (h264Delta !== 0) {
    return h264Delta;
  }
  return sortByHeightAndBitrate(leftFormat, rightFormat);
};

const pickBestProgressiveMp4 = (streamingFormats: StreamingFormat[]): StreamingFormat | null => {
  const playableProgressiveMp4 = streamingFormats.filter(
    (streamingFormat) =>
      streamingFormat.url !== null
      && streamingFormat.streamKind === 'video-audio'
      && streamingFormat.container === MIME_MP4_MARK,
  );
  playableProgressiveMp4.sort(sortByHeightAndBitrate);
  return playableProgressiveMp4[0] ?? null;
};

const pickBestAdaptiveMp4Pair = (
  streamingFormats: StreamingFormat[],
): { videoStream: StreamingFormat | null; audioStream: StreamingFormat | null } => {
  const playableMp4VideoStreams = streamingFormats.filter(
    (streamingFormat) =>
      streamingFormat.url !== null
      && streamingFormat.streamKind === 'video'
      && streamingFormat.container === MIME_MP4_MARK,
  );
  const playableMp4AudioStreams = streamingFormats.filter(
    (streamingFormat) =>
      streamingFormat.url !== null
      && streamingFormat.streamKind === 'audio'
      && streamingFormat.container === MIME_MP4_MARK,
  );
  playableMp4VideoStreams.sort(sortVideoStreamsForQuality);
  playableMp4AudioStreams.sort(sortByHeightAndBitrate);
  return {
    videoStream: playableMp4VideoStreams[0] ?? null,
    audioStream: playableMp4AudioStreams[0] ?? null,
  };
};

const formatStreamLabel = (streamingFormat: StreamingFormat): string => {
  const containerLabel = streamingFormat.container ?? 'unknown';
  const resolutionLabel = streamingFormat.height !== null ? `${streamingFormat.height}p ` : '';
  const itagLabel = streamingFormat.itag !== null ? `itag ${streamingFormat.itag} ` : '';
  const codecLabel = streamingFormat.codecs !== null ? ` (${streamingFormat.codecs})` : '';
  return `${itagLabel}${resolutionLabel}${containerLabel}${codecLabel}`;
};

const downloadStreamToFile = async (
  streamingFormat: StreamingFormat,
  destFile: string,
  mediaUserAgent: string,
): Promise<void> => {
  const downloadUrl = streamingFormat.url;
  if (!downloadUrl) {
    const streamLabel = formatStreamLabel(streamingFormat);
    throw new Error(`No playable url for stream ${streamLabel}`);
  }
  await downloadMediaToFile(
    {
      downloadUrl,
      requestHeaders: {
        [USER_AGENT_HEADER]: mediaUserAgent,
        [REFERER_HEADER]: DEFAULT_REFERRER_URL,
      },
      totalBytes: streamingFormat.contentLength,
    },
    destFile,
  );
};

const muxMp4Parts = (videoPartFile: string, audioPartFile: string, muxedFile: string): boolean => {
  try {
    runFfmpeg(['-i', videoPartFile, '-i', audioPartFile, '-c', 'copy', muxedFile]);
    return true;
  } catch (muxError) {
    const muxFailure = muxError instanceof Error ? muxError.message : String(muxError);
    logWarn(`ffmpeg mux: ${muxFailure}`);
    return false;
  }
};

const tryDownloadAdaptiveMp4 = async (
  videoStream: StreamingFormat,
  audioStream: StreamingFormat,
  videoId: string,
  outDirectory: string,
  mediaUserAgent: string,
): Promise<string | null> => {
  const videoPartFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_PART_VIDEO}`);
  const audioPartFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_PART_AUDIO}`);
  const muxedFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_MP4}`);
  try {
    logInfo(`[${videoId}] ${LOG_VIDEO_DOWNLOAD_START} ${formatStreamLabel(videoStream)}`);
    await downloadStreamToFile(videoStream, videoPartFile, mediaUserAgent);
    logInfo(`[${videoId}] ${LOG_VIDEO_DOWNLOAD_START} ${formatStreamLabel(audioStream)}`);
    await downloadStreamToFile(audioStream, audioPartFile, mediaUserAgent);
    logInfo(`[${videoId}] ${LOG_VIDEO_MUXING}`);
    const muxSucceeded = muxMp4Parts(videoPartFile, audioPartFile, muxedFile);
    if (muxSucceeded) {
      logInfo(`[${videoId}] ${LOG_VIDEO_MUX_TEMPLATE} ${muxedFile}`);
      return muxedFile;
    }
    logWarn(`[${videoId}] ffmpeg mux failed; using combined mp4 instead`);
    return null;
  } catch (adaptiveError) {
    // Adaptive streams refused or throttled; fall back to combined mp4.
    const failureText =
      adaptiveError instanceof Error ? adaptiveError.message : String(adaptiveError);
    logWarn(
      `[${videoId}] adaptive download unavailable (${failureText}); using combined mp4 instead`,
    );
    return null;
  } finally {
    await rm(videoPartFile, { force: true });
    await rm(audioPartFile, { force: true });
  }
};

export const downloadVideoWithPlayerApi = async (
  watchUrl: string,
  videoId: string,
  outDirectory: string,
): Promise<string> => {
  // Best-quality streams come as a video + audio pair that only ffmpeg can join.
  requireFfmpeg();

  // Fast path: Innertube player payload (no watch HTML) with streaming formats.
  let playerPayloadWithClient = await fetchPlayerPayloadFromPlayerApi(watchUrl, videoId, null);

  // Slow path: watch HTML for ytInitialPlayerResponse when no client returned streams.
  if (!playerPayloadWithClient) {
    logWarn(`[${videoId}] ${LOG_WATCH_HTML_SKIPPED}`);
    const watchPage = await fetchTextResourceOptional(watchUrl);
    const pageHtml = watchPage?.bodyText ?? null;
    if (pageHtml) {
      const embeddedPayload = extractEmbeddedJson(
        pageHtml,
        YOUTUBE_INITIAL_PLAYER_RESPONSE_MARKER,
      );
      if (embeddedPayload) {
        playerPayloadWithClient = { playerPayload: embeddedPayload };
      } else {
        playerPayloadWithClient = await fetchPlayerPayloadFromPlayerApi(watchUrl, videoId, pageHtml);
      }
    }
  }
  const playerPayload = playerPayloadWithClient?.playerPayload ?? null;
  if (!playerPayload) {
    throw new Error(`${LOG_VIDEO_NO_FORMATS} ${videoId}`);
  }

  // Media requests must use the User-Agent of the client that minted the stream;
  // a mismatched (browser) UA gets throttled to ~0.1 MiB/s. Payloads lifted from
  // the watch HTML page are web-client minted, so keep the browser UA for them.
  const mediaUserAgent = playerPayloadWithClient?.clientProfile?.userAgent ?? BROWSER_USER_AGENT;

  const streamingFormats = parseStreamingFormatsFromPayload(playerPayload);
  const playableFormats = streamingFormats.filter(
    (streamingFormat) => streamingFormat.url !== null,
  );
  if (playableFormats.length === 0) {
    throw new Error(`${LOG_VIDEO_NO_FORMATS} ${videoId}`);
  }

  // 1) Highest quality: best mp4 video (H.264 preferred) + best mp4 audio, muxed.
  //    Adaptive URLs are servable after the visitor bootstrap; fall back when refused.
  const adaptivePair = pickBestAdaptiveMp4Pair(playableFormats);
  if (adaptivePair.videoStream && adaptivePair.audioStream) {
    const muxedFile = await tryDownloadAdaptiveMp4(
      adaptivePair.videoStream,
      adaptivePair.audioStream,
      videoId,
      outDirectory,
      mediaUserAgent,
    );
    if (muxedFile) {
      return muxedFile;
    }
  }

  // 2) Fallback: combined mp4 (audio+video in one stream) — no mux needed.
  const progressiveMp4 = pickBestProgressiveMp4(playableFormats);
  if (progressiveMp4) {
    logInfo(`${LOG_VIDEO_DOWNLOAD_START} ${formatStreamLabel(progressiveMp4)}`);
    const progressiveFile = path.join(outDirectory, `${videoId}${MEDIA_EXTENSION_MP4}`);
    await downloadStreamToFile(progressiveMp4, progressiveFile, mediaUserAgent);
    logInfo(`${LOG_VIDEO_SAVED_TEMPLATE} ${progressiveFile}`);
    return progressiveFile;
  }

  throw new Error(`${LOG_VIDEO_NO_FORMATS} ${videoId}`);
};
