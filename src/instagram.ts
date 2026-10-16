import { Effect, Schema } from 'effect';
import { request } from 'undici';

import { downloadMediaToFile } from './media-download.js';

import { CONSTANTS } from './constants.js';

const { INSTAGRAM_HOST_MARK, BROWSER_USER_AGENT, NEWLINE } = CONSTANTS.shared;
const { USER_AGENT_HEADER, REFERER_HEADER } = CONSTANTS.http;
const {
  SHORTCODE_PATTERN,
  SHORTCODE_CAPTURE_GROUP,
  PAGE_URL_PREFIX,
  PAGE_URL_SUFFIX,
  REFERER_URL,
  PAGE_HEADERS,
  HTTP_STATUS_OK,
  JSON_SCRIPT_PATTERN,
  JSON_SCRIPT_CAPTURE_GROUP,
  POLARIS_MEDIA_KEY,
  OWNER_HANDLE_PREFIX,
  LOG_INVALID_URL,
  LOG_PAGE_FAILED,
  LOG_NO_MEDIA,
  LOG_NO_VIDEO,
} = CONSTANTS.instagram;

// Public Instagram reel or video post resolved from its page.
export type InstagramReel = {
  // Post shortcode from the URL, such as `DeRhrhdMuTh`.
  shortcode: string;
  // Canonical post page URL.
  pageUrl: string;
  // First caption line, or the owner handle when the caption is empty.
  title: string;
  // Direct progressive mp4 URL (H.264 + AAC in one file).
  videoUrl: string;
};

const videoVersionSchema = Schema.Struct({
  // Signed CDN URL for one progressive mp4 rendition.
  url: Schema.String,
});

const reelMediaSchema = Schema.Struct({
  // Post owner.
  user: Schema.Struct({
    // Public handle without the leading `@`.
    username: Schema.String,
  }),
  // Post description; null when the owner left it empty.
  caption: Schema.optionalWith(
    Schema.NullOr(
      Schema.Struct({
        // Caption body as typed by the owner.
        text: Schema.String,
      }),
    ),
    { default: () => null },
  ),
  // Progressive mp4 renditions, best first; null for photo posts.
  video_versions: Schema.optionalWith(Schema.NullOr(Schema.Array(videoVersionSchema)), {
    default: () => null,
  }),
});

const polarisMediaSchema = Schema.Struct({
  // Media visible without login; null when the post is private or gated.
  if_not_gated_logged_out: Schema.optionalWith(Schema.NullOr(reelMediaSchema), {
    default: () => null,
  }),
});

const decodePolarisMedia = Schema.decodeUnknown(polarisMediaSchema);

export const isInstagramUrl = (sourceUrl: string): boolean =>
  sourceUrl.toLowerCase().includes(INSTAGRAM_HOST_MARK);

const findNestedValue = (jsonNode: unknown, targetKey: string): unknown => {
  if (Array.isArray(jsonNode)) {
    for (const childNode of jsonNode) {
      const nestedValue = findNestedValue(childNode, targetKey);
      if (nestedValue !== undefined) {
        return nestedValue;
      }
    }
    return undefined;
  }
  if (typeof jsonNode !== 'object' || jsonNode === null) {
    return undefined;
  }
  const objectNode = jsonNode as Record<string, unknown>;
  if (targetKey in objectNode) {
    return objectNode[targetKey];
  }
  const childNodes = Object.values(objectNode);
  return findNestedValue(childNodes, targetKey);
};

const parseScriptJson = (scriptBody: string): unknown => {
  try {
    return JSON.parse(scriptBody);
  } catch {
    return undefined;
  }
};

const findPolarisMedia = (pageHtml: string): unknown => {
  for (const scriptMatch of pageHtml.matchAll(JSON_SCRIPT_PATTERN)) {
    const scriptJson = parseScriptJson(scriptMatch[JSON_SCRIPT_CAPTURE_GROUP]);
    const polarisMedia = findNestedValue(scriptJson, POLARIS_MEDIA_KEY);
    if (polarisMedia !== undefined) {
      return polarisMedia;
    }
  }
  return undefined;
};

const fetchPostPage = async (pageUrl: string): Promise<string> => {
  // undici `request` keeps `sec-fetch-mode: navigate`; global fetch forces `cors`
  // and Instagram then leaves the media out of the page.
  const pageReply = await request(pageUrl, {
    headers: { [USER_AGENT_HEADER]: BROWSER_USER_AGENT, ...PAGE_HEADERS },
  });
  if (pageReply.statusCode !== HTTP_STATUS_OK) {
    await pageReply.body.dump();
    throw new Error(`${LOG_PAGE_FAILED} ${pageReply.statusCode}: ${pageUrl}`);
  }
  return pageReply.body.text();
};

const composeReelTitle = (captionText: string | null, ownerUsername: string): string => {
  const ownerHandle = `${OWNER_HANDLE_PREFIX}${ownerUsername}`;
  if (!captionText) {
    return ownerHandle;
  }
  const firstCaptionLine = captionText.split(NEWLINE)[0].trim();
  return firstCaptionLine || ownerHandle;
};

export const fetchInstagramReel = async (sourceUrl: string): Promise<InstagramReel> => {
  const shortcodeMatch = SHORTCODE_PATTERN.exec(sourceUrl);
  if (!shortcodeMatch) {
    throw new Error(`${LOG_INVALID_URL} ${sourceUrl}`);
  }
  const shortcode = shortcodeMatch[SHORTCODE_CAPTURE_GROUP];
  const pageUrl = `${PAGE_URL_PREFIX}${shortcode}${PAGE_URL_SUFFIX}`;
  const pageHtml = await fetchPostPage(pageUrl);
  const polarisMedia = findPolarisMedia(pageHtml);
  if (polarisMedia === undefined) {
    throw new Error(`${LOG_NO_MEDIA} ${pageUrl}`);
  }
  const decodedMedia = await Effect.runPromise(decodePolarisMedia(polarisMedia));
  const reelMedia = decodedMedia.if_not_gated_logged_out;
  if (!reelMedia) {
    throw new Error(`${LOG_NO_MEDIA} ${pageUrl}`);
  }
  const bestVideo = reelMedia.video_versions?.[0];
  if (!bestVideo) {
    throw new Error(`${LOG_NO_VIDEO} ${pageUrl}`);
  }
  const captionText = reelMedia.caption ? reelMedia.caption.text : null;
  const title = composeReelTitle(captionText, reelMedia.user.username);
  return { shortcode, pageUrl, title, videoUrl: bestVideo.url };
};

export const downloadInstagramVideo = async (
  instagramReel: InstagramReel,
  videoFile: string,
): Promise<void> => {
  await downloadMediaToFile(
    {
      downloadUrl: instagramReel.videoUrl,
      requestHeaders: {
        [USER_AGENT_HEADER]: BROWSER_USER_AGENT,
        [REFERER_HEADER]: REFERER_URL,
      },
      totalBytes: null,
    },
    videoFile,
  );
};
