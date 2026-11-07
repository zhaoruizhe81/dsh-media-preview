/**
 * Host half of the media preview bundle.
 *
 * Provides one authenticated, Range-capable route that lets the browser play the
 * media formats Chromium can decode natively and transparently transcodes the
 * ones it cannot (e.g. HEVC/H.265 `.mp4` from cameras and phones) to H.264/AAC:
 *
 *   GET /api/media-preview/transcode?path=<absolute-path>
 *
 * Behaviour:
 *   - probe the input with `ffprobe` (cached by path + size + mtime);
 *   - if the video/audio codecs are browser-playable, serve the original file;
 *   - otherwise transcode once to a cached H.264/AAC MP4 (or AAC/M4A for
 *     audio-only input) and serve that;
 *   - always stream with HTTP Range support so `<video>` can seek.
 *
 * The route runs through `ctx.connection.fetch`, so it inherits the same
 * authenticated owner-peer trust as `/api/file`.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { Readable } from 'node:stream';

const CACHE_DIR = join(tmpdir(), 'dsh-media-preview-cache');

// Codecs the Chromium/Electron renderer can decode without transcoding.
const VIDEO_OK = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
const AUDIO_OK = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'alac']);

const EXT_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/ogg',
  weba: 'audio/webm',
};

const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

/** Locate a CLI tool; Finder-launched apps often lack /opt/homebrew/bin on PATH. */
function resolveTool(name) {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

function mimeForExt(filePath) {
  const ext = extname(filePath).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

function isAbsolutePath(path) {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

function run(command, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr && String(stderr).trim()) || error.message;
        reject(new Error(`${command} failed: ${detail}`));
        return;
      }
      resolve(String(stdout));
    });
  });
}

const probeCache = new Map(); // cacheKey -> {video, audio}
const preparedCache = new Map(); // cacheKey -> {file, mime}
const inflight = new Map(); // outputPath -> Promise

function cacheIdentity(inputPath, stat) {
  const hash = createHash('sha1');
  hash.update(inputPath);
  hash.update('\0');
  hash.update(String(stat.size));
  hash.update('\0');
  hash.update(String(stat.mtimeMs));
  return hash.digest('hex');
}

async function probe(inputPath) {
  const ffprobe = resolveTool('ffprobe');
  const stdout = await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', inputPath], 30000);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = { streams: [] };
  }
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  return { video: video ? video.codec_name : undefined, audio: audio ? audio.codec_name : undefined };
}

function isPlayable(info) {
  if (info.video !== undefined) {
    if (!VIDEO_OK.has(info.video)) return false;
    if (info.audio !== undefined && !AUDIO_OK.has(info.audio)) return false;
    return true;
  }
  if (info.audio !== undefined) return AUDIO_OK.has(info.audio);
  return false;
}

async function transcode(inputPath, outputPath, audioOnly) {
  if (existsSync(outputPath)) return outputPath;
  if (inflight.has(outputPath)) {
    await inflight.get(outputPath);
    return outputPath;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const ffmpeg = resolveTool('ffmpeg');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath];
  if (audioOnly) {
    args.push('-vn', '-c:a', 'aac', '-b:a', '160k');
  } else {
    args.push(
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
    );
  }
  args.push('-movflags', '+faststart', outputPath);
  const task = run(ffmpeg, args, 1000 * 60 * 30).finally(() => inflight.delete(outputPath));
  inflight.set(outputPath, task);
  await task;
  return outputPath;
}

/** Decide what file to serve for an input path, transcoding once when needed. */
async function prepare(inputPath) {
  const stat = statSync(inputPath);
  if (!stat.isFile()) throw new Error('not a regular file');
  const key = cacheIdentity(inputPath, stat);
  const cached = preparedCache.get(key);
  if (cached !== undefined) return cached;

  let info = probeCache.get(key);
  if (info === undefined) {
    info = await probe(inputPath);
    probeCache.set(key, info);
  }

  let result;
  if (isPlayable(info)) {
    result = { file: inputPath, mime: mimeForExt(inputPath) };
  } else {
    const audioOnly = info.video === undefined;
    const outputPath = join(CACHE_DIR, `${key}${audioOnly ? '.m4a' : '.mp4'}`);
    await transcode(inputPath, outputPath, audioOnly);
    result = { file: outputPath, mime: audioOnly ? 'audio/mp4' : 'video/mp4' };
  }
  preparedCache.set(key, result);
  return result;
}

/** Build a Range-aware streaming Response for a prepared file. */
function fileResponse(filePath, mime, request) {
  const size = statSync(filePath).size;
  const rangeHeader = request.headers.get('range');
  let start = 0;
  let end = size - 1;
  let status = 200;

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
    if (match) {
      if (match[1] === '' && match[2] !== '') {
        const suffix = Number.parseInt(match[2], 10);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else if (match[1] !== '') {
        start = Number.parseInt(match[1], 10);
        end = match[2] === '' ? size - 1 : Math.min(Number.parseInt(match[2], 10), size - 1);
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...NO_STORE, 'Content-Range': `bytes */${size}` } });
      }
      status = 206;
    }
  }

  const length = end - start + 1;
  const headers = {
    ...NO_STORE,
    'Content-Type': mime,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const nodeStream = createReadStream(filePath, { start, end });
  return new Response(Readable.toWeb(nodeStream), { status, headers });
}

async function serve(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  if (path === null || path.length === 0 || path.includes('\0') || !isAbsolutePath(path)) {
    return new Response('absolute path required', { status: 400, headers: NO_STORE });
  }
  try {
    const prepared = await prepare(path);
    return fileResponse(prepared.file, prepared.mime, request);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return new Response(`media preview failed: ${message}`, { status: 500, headers: NO_STORE });
  }
}

export const inject = ['connection'];

export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/media-preview/transcode',
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => serve(request),
      }),
    'media-preview: transcode route',
  );
}
