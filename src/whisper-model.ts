import { access, rename } from 'node:fs/promises';
import path from 'node:path';

import { downloadMediaToFile } from './media-download.js';
import { resolveCacheRoot } from './transcript-cache.js';
import { logInfo } from './log.js';

import { CONSTANTS } from './constants.js';

const { BROWSER_USER_AGENT } = CONSTANTS.shared;
const { USER_AGENT_HEADER } = CONSTANTS.http;
const {
  MODEL_DOWNLOAD_URL_PREFIX,
  MODEL_FILE_PREFIX,
  MODEL_FILE_EXTENSION,
  MODEL_CACHE_FOLDER,
  PARTIAL_DOWNLOAD_EXTENSION,
  LOG_MODEL_DOWNLOAD,
  LOG_MODEL_READY,
} = CONSTANTS.whisperModel;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const ensureWhisperModel = async (modelName: string): Promise<string> => {
  const modelFileName = `${MODEL_FILE_PREFIX}${modelName}${MODEL_FILE_EXTENSION}`;
  const cacheRoot = resolveCacheRoot();
  const modelFile = path.join(cacheRoot, MODEL_CACHE_FOLDER, modelFileName);
  const modelCached = await fileExists(modelFile);
  if (modelCached) {
    logInfo(`${LOG_MODEL_READY} ${modelFile}`);
    return modelFile;
  }

  // Download beside the final name and rename at the end, so a broken
  // download never looks like a cached model. The pid keeps parallel runs apart.
  logInfo(`${LOG_MODEL_DOWNLOAD} ${modelFileName}`);
  const partialFile = `${modelFile}.${process.pid}${PARTIAL_DOWNLOAD_EXTENSION}`;
  await downloadMediaToFile(
    {
      downloadUrl: `${MODEL_DOWNLOAD_URL_PREFIX}${modelFileName}`,
      requestHeaders: { [USER_AGENT_HEADER]: BROWSER_USER_AGENT },
      totalBytes: null,
    },
    partialFile,
  );
  await rename(partialFile, modelFile);
  logInfo(`${LOG_MODEL_READY} ${modelFile}`);
  return modelFile;
};
