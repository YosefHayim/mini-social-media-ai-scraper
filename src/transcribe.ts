import { Effect, Schema } from 'effect';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CONSTANTS } from './constants.js';

const { FILE_ENCODING } = CONSTANTS.shared;
const { FFMPEG_BINARY_NAME } = CONSTANTS.ffmpeg;
const {
  WHISPER_BINARY_NAME,
  WHISPER_VERSION_FLAG,
  FFMPEG_VERSION_FLAG,
  WHISPER_LANGUAGE_AUTO,
  WHISPER_TIMEOUT_MS,
  WHISPER_ERROR_PREVIEW_LENGTH,
  WHISPER_WORK_DIR_PREFIX,
  WHISPER_OUTPUT_BASENAME,
  VTT_EXTENSION,
  JSON_EXTENSION,
  WHISPER_MISSING_HINT,
  FFMPEG_MISSING_HINT,
} = CONSTANTS.transcribe;

// Local speech-to-text output for one audio file.
export type SpeechTranscript = {
  // Spoken language whisper detected, such as `en`.
  languageTag: string;
  // WebVTT body with timed cues.
  vttBody: string;
};

const whisperReportSchema = Schema.Struct({
  // Run summary whisper.cpp writes with `-oj`.
  result: Schema.Struct({
    // Detected (or forced) spoken language code.
    language: Schema.String,
  }),
});

const decodeWhisperReport = Schema.decodeUnknown(Schema.parseJson(whisperReportSchema));

const isBinaryOnPath = (binaryName: string, versionFlag: string): boolean => {
  const probeRun = spawnSync(binaryName, [versionFlag], { stdio: 'ignore' });
  return !probeRun.error;
};

export const requireTranscribeTools = (): void => {
  const whisperReady = isBinaryOnPath(WHISPER_BINARY_NAME, WHISPER_VERSION_FLAG);
  if (!whisperReady) {
    throw new Error(WHISPER_MISSING_HINT);
  }
  const ffmpegReady = isBinaryOnPath(FFMPEG_BINARY_NAME, FFMPEG_VERSION_FLAG);
  if (!ffmpegReady) {
    throw new Error(FFMPEG_MISSING_HINT);
  }
};

const runWhisperCli = (audioFile: string, modelFile: string, outputBase: string): void => {
  const whisperRun = spawnSync(
    WHISPER_BINARY_NAME,
    ['-m', modelFile, '-f', audioFile, '-l', WHISPER_LANGUAGE_AUTO, '-ovtt', '-oj', '-of', outputBase, '-np'],
    {
      encoding: 'utf8',
      timeout: WHISPER_TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    },
  );
  if (whisperRun.error) {
    throw new Error(`${WHISPER_BINARY_NAME}: ${whisperRun.error.message}`);
  }
  if (whisperRun.status !== 0) {
    const whisperErrorBody = whisperRun.stderr.trim();
    throw new Error(
      `${WHISPER_BINARY_NAME} failed: ${whisperErrorBody.slice(0, WHISPER_ERROR_PREVIEW_LENGTH)}`,
    );
  }
};

export const transcribeAudioFile = async (
  audioFile: string,
  modelFile: string,
): Promise<SpeechTranscript> => {
  const workPrefix = path.join(tmpdir(), WHISPER_WORK_DIR_PREFIX);
  const workDirectory = await mkdtemp(workPrefix);
  const outputBase = path.join(workDirectory, WHISPER_OUTPUT_BASENAME);
  try {
    runWhisperCli(audioFile, modelFile, outputBase);
    const reportBody = await readFile(`${outputBase}${JSON_EXTENSION}`, FILE_ENCODING);
    const whisperReport = await Effect.runPromise(decodeWhisperReport(reportBody));
    const vttBody = await readFile(`${outputBase}${VTT_EXTENSION}`, FILE_ENCODING);
    return { languageTag: whisperReport.result.language, vttBody };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
};
