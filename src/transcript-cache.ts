import { Option, Schema } from 'effect';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

import { outputFormatValues, subtitleFormatValues } from './types.js';

import { CONSTANTS } from './constants.js';

const { EMPTY_VALUE, FILE_ENCODING, VIDEO_ID_PATTERN } = CONSTANTS.shared;
const { LANGUAGE_TAG_PATTERN } = CONSTANTS.transcriptCache;

const cachedArtifactSchema = Schema.Struct({
  // Video the file belongs to; replay uses it in the output file name.
  videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  // Caption language tag; replay uses it in the output file name.
  languageTag: Schema.String.pipe(Schema.pattern(LANGUAGE_TAG_PATTERN)),
  // Caption format fetched from YouTube.
  sourceFormat: Schema.Literal(...subtitleFormatValues),
  // Format of the written file.
  outputFormat: Schema.Literal(...subtitleFormatValues, ...outputFormatValues),
  // File body exactly as written.
  outputText: Schema.String,
  // Always null in the cache; replay sets the new path.
  outputPath: Schema.Null,
});

const transcriptCacheEntrySchema = Schema.Struct({
  // Cached video id.
  videoId: Schema.String.pipe(Schema.pattern(VIDEO_ID_PATTERN)),
  // Caption language tag.
  languageTag: Schema.String.pipe(Schema.pattern(LANGUAGE_TAG_PATTERN)),
  // Lookup key: requested languages, caption formats, export format, caption kind.
  cacheKey: Schema.String,
  // Output files as the fresh run wrote them, replayed on a hit.
  artifacts: Schema.Array(cachedArtifactSchema).pipe(Schema.minItems(1)),
  // Plain transcript body for the local agent.
  transcriptBody: Schema.NonEmptyString,
  // Human title when known.
  videoName: Schema.NullOr(Schema.String),
  // ISO timestamp when written.
  cachedAt: Schema.String,
});

// Disk cache entry for one video + language + output selection.
export type TranscriptCacheEntry = Schema.Schema.Type<typeof transcriptCacheEntrySchema>;

const decodeCacheEntry = Schema.decodeUnknownOption(Schema.parseJson(transcriptCacheEntrySchema));

export const resolveCacheRoot = (): string => {
  // Prefer XDG, then ~/.cache/mini-social-media-ai-scraper.
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim() ?? EMPTY_VALUE;
  if (xdgCacheHome.length > 0) {
    return path.join(xdgCacheHome, 'mini-social-media-ai-scraper');
  }
  return path.join(homedir(), '.cache', 'mini-social-media-ai-scraper');
};

const renderCacheFilePath = (videoId: string, cacheKey: string): string => {
  const safeCacheKey = cacheKey.replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(resolveCacheRoot(), 'transcripts', `${videoId}.${safeCacheKey}.json`);
};

export const readTranscriptCache = async (
  videoId: string,
  cacheKey: string,
): Promise<TranscriptCacheEntry | null> => {
  const cacheFilePath = renderCacheFilePath(videoId, cacheKey);
  try {
    const rawBody = await readFile(cacheFilePath, FILE_ENCODING);
    const decodedEntry = decodeCacheEntry(rawBody);
    const cacheEntry = Option.getOrNull(decodedEntry);
    if (!cacheEntry || cacheEntry.videoId !== videoId) {
      return null;
    }
    return cacheEntry;
  } catch {
    return null;
  }
};

export const writeTranscriptCache = async (cacheEntry: TranscriptCacheEntry): Promise<void> => {
  const cacheFilePath = renderCacheFilePath(cacheEntry.videoId, cacheEntry.cacheKey);
  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(
    cacheFilePath,
    `${JSON.stringify(cacheEntry, null, 2)}\n`,
    FILE_ENCODING,
  );
};
