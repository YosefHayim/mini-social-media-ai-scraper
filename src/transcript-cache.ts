import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

import type { TranscriptArtifact } from './types.js';

import { CONSTANTS } from './constants.js';

const { EMPTY_VALUE, FILE_ENCODING } = CONSTANTS.shared;

// Disk cache entry for one video + language + output selection.
export type TranscriptCacheEntry = {
  // Cached video id.
  videoId: string;
  // Caption language tag.
  languageTag: string;
  // Output selection key: caption formats plus export format.
  outputKey: string;
  // Output files as the fresh run wrote them, replayed on a hit.
  artifacts: TranscriptArtifact[];
  // Plain transcript body for the local agent.
  transcriptBody: string;
  // Human title when known.
  videoName: string | null;
  // ISO timestamp when written.
  cachedAt: string;
};

export const resolveCacheRoot = (): string => {
  // Prefer XDG, then ~/.cache/mini-social-media-ai-scraper.
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim() ?? EMPTY_VALUE;
  if (xdgCacheHome.length > 0) {
    return path.join(xdgCacheHome, 'mini-social-media-ai-scraper');
  }
  return path.join(homedir(), '.cache', 'mini-social-media-ai-scraper');
};

const renderCacheFilePath = (videoId: string, languageTag: string, outputKey: string): string => {
  const safeLang = languageTag.replace(/[^A-Za-z0-9._-]+/g, '_') || 'und';
  const safeOutputKey = outputKey.replace(/[^A-Za-z0-9._-]+/g, '_');
  return path.join(resolveCacheRoot(), 'transcripts', `${videoId}.${safeLang}.${safeOutputKey}.json`);
};

export const readTranscriptCache = async (
  videoId: string,
  languageTag: string,
  outputKey: string,
): Promise<TranscriptCacheEntry | null> => {
  const cacheFilePath = renderCacheFilePath(videoId, languageTag, outputKey);
  try {
    const rawBody = await readFile(cacheFilePath, FILE_ENCODING);
    const parsedBody = JSON.parse(rawBody) as TranscriptCacheEntry;
    if (
      typeof parsedBody.transcriptBody !== 'string'
      || parsedBody.transcriptBody.length === 0
      || !Array.isArray(parsedBody.artifacts)
      || parsedBody.artifacts.length === 0
      || parsedBody.videoId !== videoId
    ) {
      return null;
    }
    return parsedBody;
  } catch {
    return null;
  }
};

export const writeTranscriptCache = async (cacheEntry: TranscriptCacheEntry): Promise<void> => {
  const cacheFilePath = renderCacheFilePath(
    cacheEntry.videoId,
    cacheEntry.languageTag,
    cacheEntry.outputKey,
  );
  await mkdir(path.dirname(cacheFilePath), { recursive: true });
  await writeFile(
    cacheFilePath,
    `${JSON.stringify(cacheEntry, null, 2)}\n`,
    FILE_ENCODING,
  );
};
