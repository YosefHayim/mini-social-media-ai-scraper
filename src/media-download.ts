import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import path from 'node:path';

import { logInfo } from './log.js';

import { CONSTANTS } from './constants.js';

const { ACCEPT_HEADER, ACCEPT_ALL } = CONSTANTS.http;
const {
  PROGRESS_LOG_STEP_PERCENT,
  RANGE_HEADER_NAME,
  PROBE_BYTE_RANGE,
  MEDIA_PARALLEL_CHUNKS,
  CHUNK_RETRY_ATTEMPTS,
  CHUNK_RETRY_DELAY_MS,
  LOG_DOWNLOAD_PROGRESS,
  LOG_DOWNLOAD_DONE,
} = CONSTANTS.mediaDownload;

// One media file to fetch and the headers its CDN expects.
export type MediaRequest = {
  // Direct media URL.
  downloadUrl: string;
  // Headers sent with every probe and chunk request (User-Agent, Referer, ...).
  requestHeaders: Record<string, string>;
  // Declared byte length when known; null probes it with a one-byte range.
  totalBytes: number | null;
};

// Shared byte counter across parallel chunk downloads.
type DownloadProgress = {
  // Bytes received so far across all chunks.
  downloadedBytes: number;
  // Full media size in bytes.
  totalBytes: number;
  // Last logged percent, so progress logs once per step.
  lastPercent: number;
};

// Bytes one chunk attempt added to the shared progress.
type ChunkAttempt = {
  // Bytes this attempt received before it finished or failed.
  receivedBytes: number;
};

export const formatBytes = (byteCount: number): string => {
  if (byteCount >= 1024 * 1024 * 1024) {
    return `${(byteCount / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }
  if (byteCount >= 1024 * 1024) {
    return `${(byteCount / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (byteCount >= 1024) {
    return `${(byteCount / 1024).toFixed(1)} KiB`;
  }
  return `${byteCount} B`;
};

const parseContentRangeTotal = (contentRangeHeader: string | null): number | null => {
  if (!contentRangeHeader) {
    return null;
  }
  const totalToken = contentRangeHeader.split('/')[1];
  if (!totalToken) {
    return null;
  }
  const totalBytes = Number(totalToken);
  return Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
};

const sleepBriefly = (delayMs: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, delayMs);
  });

const fetchByteRange = (mediaRequest: MediaRequest, byteRange: string): Promise<Response> =>
  fetch(mediaRequest.downloadUrl, {
    headers: {
      [ACCEPT_HEADER]: ACCEPT_ALL,
      ...mediaRequest.requestHeaders,
      [RANGE_HEADER_NAME]: byteRange,
    },
  });

const probeTotalBytes = async (mediaRequest: MediaRequest): Promise<number> => {
  const probeReply = await fetchByteRange(mediaRequest, PROBE_BYTE_RANGE);
  if (!probeReply.ok) {
    throw new Error(`HTTP ${probeReply.status} while probing stream size`);
  }
  const contentRangeHeader = probeReply.headers.get('content-range');
  const totalBytes = parseContentRangeTotal(contentRangeHeader);
  await probeReply.body?.cancel().catch(() => undefined);
  if (totalBytes === null) {
    throw new Error(`Stream size not exposed in Content-Range`);
  }
  return totalBytes;
};

const logProgressStep = (downloadProgress: DownloadProgress): void => {
  const progressPercent = Math.floor(
    (downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100,
  );
  if (progressPercent < downloadProgress.lastPercent + PROGRESS_LOG_STEP_PERCENT) {
    return;
  }
  downloadProgress.lastPercent = progressPercent;
  const downloadedLabel = formatBytes(downloadProgress.downloadedBytes);
  const totalLabel = formatBytes(downloadProgress.totalBytes);
  logInfo(`${LOG_DOWNLOAD_PROGRESS}: ${progressPercent}% (${downloadedLabel}/${totalLabel})`);
};

const appendBodyToFile = async (
  mediaStream: ReadableStream,
  writeStream: Writable,
  downloadProgress: DownloadProgress,
  chunkAttempt: ChunkAttempt,
): Promise<void> => {
  const nodeStream = Readable.fromWeb(mediaStream);
  for await (const mediaChunk of nodeStream) {
    const chunkBuffer = Buffer.isBuffer(mediaChunk) ? mediaChunk : Buffer.from(mediaChunk as Uint8Array);
    chunkAttempt.receivedBytes += chunkBuffer.byteLength;
    downloadProgress.downloadedBytes += chunkBuffer.byteLength;
    logProgressStep(downloadProgress);
    if (!writeStream.write(chunkBuffer)) {
      await new Promise<void>((wakeUp) => writeStream.once('drain', wakeUp));
    }
  }
};

const closeWriteStream = (writeStream: Writable): Promise<void> => {
  writeStream.end();
  return new Promise<void>((wakeUp, rejectWrite) => {
    writeStream.once('finish', wakeUp);
    writeStream.once('error', rejectWrite);
  });
};

const downloadChunkOnce = async (
  mediaRequest: MediaRequest,
  byteRange: string,
  destFile: string,
  downloadProgress: DownloadProgress,
): Promise<void> => {
  const chunkReply = await fetchByteRange(mediaRequest, byteRange);
  if (!chunkReply.ok) {
    throw new Error(`HTTP ${chunkReply.status} while downloading range ${byteRange}`);
  }
  if (!chunkReply.body) {
    throw new Error(`Empty body while downloading range ${byteRange}`);
  }
  const writeStream = createWriteStream(destFile);
  writeStream.setMaxListeners(0);
  const chunkAttempt: ChunkAttempt = { receivedBytes: 0 };
  try {
    await appendBodyToFile(chunkReply.body as ReadableStream, writeStream, downloadProgress, chunkAttempt);
    await closeWriteStream(writeStream);
  } catch (streamError) {
    // A retry rewrites the whole chunk, so its partial bytes leave the shared count.
    downloadProgress.downloadedBytes -= chunkAttempt.receivedBytes;
    writeStream.destroy();
    throw streamError;
  }
};

const downloadChunkToFile = async (
  mediaRequest: MediaRequest,
  byteRange: string,
  destFile: string,
  downloadProgress: DownloadProgress,
  attemptsLeft: number = CHUNK_RETRY_ATTEMPTS,
): Promise<void> => {
  try {
    await downloadChunkOnce(mediaRequest, byteRange, destFile, downloadProgress);
  } catch (chunkError) {
    if (attemptsLeft <= 1) {
      throw chunkError;
    }
    await sleepBriefly(CHUNK_RETRY_DELAY_MS);
    await downloadChunkToFile(mediaRequest, byteRange, destFile, downloadProgress, attemptsLeft - 1);
  }
};

const resolveTotalBytes = async (mediaRequest: MediaRequest): Promise<number> => {
  if (mediaRequest.totalBytes !== null) {
    return mediaRequest.totalBytes;
  }
  return probeTotalBytes(mediaRequest);
};

export const downloadMediaToFile = async (
  mediaRequest: MediaRequest,
  destFile: string,
): Promise<void> => {
  const destDirectory = path.dirname(destFile);
  await mkdir(destDirectory, { recursive: true });

  // Bounded ranges download full-speed while unbounded (`bytes=0-`) requests are
  // throttled to ~1 Mbps; the cap is per-connection, so split the file into
  // parallel chunks that each get their own connection.
  const totalBytes = await resolveTotalBytes(mediaRequest);
  const chunkCount = Math.min(MEDIA_PARALLEL_CHUNKS, totalBytes);
  const chunkSize = Math.ceil(totalBytes / chunkCount);
  const allChunkStarts = Array.from({ length: chunkCount }, (_, chunkIndex) => chunkIndex * chunkSize);
  const chunkStarts = allChunkStarts.filter((rangeStart) => rangeStart < totalBytes);
  const chunkRanges = chunkStarts.map((rangeStart) => {
    const rangeEnd = Math.min(rangeStart + chunkSize, totalBytes) - 1;
    return `bytes=${rangeStart}-${rangeEnd}`;
  });
  const partFiles = chunkStarts.map((_, chunkIndex) => `${destFile}.part${chunkIndex}`);

  const downloadProgress: DownloadProgress = {
    downloadedBytes: 0,
    totalBytes,
    lastPercent: 0,
  };
  try {
    await Promise.all(
      chunkRanges.map((byteRange, chunkIndex) =>
        downloadChunkToFile(mediaRequest, byteRange, partFiles[chunkIndex], downloadProgress),
      ),
    );

    const writeStream = createWriteStream(destFile);
    writeStream.setMaxListeners(0);
    for (const partFile of partFiles) {
      const partStream = createReadStream(partFile);
      await pipeline(partStream, writeStream, { end: false });
    }
    await closeWriteStream(writeStream);
  } finally {
    await Promise.all(partFiles.map((partFile) => rm(partFile, { force: true })));
  }

  const downloadedLabel = formatBytes(downloadProgress.downloadedBytes);
  const destFileName = path.basename(destFile);
  logInfo(`${LOG_DOWNLOAD_DONE} ${downloadedLabel} → ${destFileName}`);
};
