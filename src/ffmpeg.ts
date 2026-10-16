import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';

import { CONSTANTS } from './constants.js';

const {
  FFMPEG_BINARY_NAME,
  FFMPEG_TIMEOUT_MS,
  FFMPEG_BASE_ARGUMENTS,
  FFMPEG_ERROR_PREVIEW_LENGTH,
  MP3_ENCODE_ARGUMENTS,
} = CONSTANTS.ffmpeg;

export const runFfmpeg = (ffmpegArguments: string[]): void => {
  const ffmpegRun = spawnSync(FFMPEG_BINARY_NAME, [...FFMPEG_BASE_ARGUMENTS, ...ffmpegArguments], {
    encoding: 'utf8',
    timeout: FFMPEG_TIMEOUT_MS,
    env: process.env,
  });
  if (ffmpegRun.error) {
    throw new Error(`${FFMPEG_BINARY_NAME}: ${ffmpegRun.error.message}`);
  }
  if (ffmpegRun.status !== 0) {
    const ffmpegErrorBody = ffmpegRun.stderr.trim();
    throw new Error(
      `${FFMPEG_BINARY_NAME} failed: ${ffmpegErrorBody.slice(0, FFMPEG_ERROR_PREVIEW_LENGTH)}`,
    );
  }
};

export const extractMp3Audio = async (mediaFile: string, mp3File: string): Promise<void> => {
  try {
    runFfmpeg(['-i', mediaFile, ...MP3_ENCODE_ARGUMENTS, mp3File]);
  } catch (ffmpegError) {
    await rm(mp3File, { force: true });
    throw ffmpegError;
  }
};
