import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MediaSource = "youtube" | "instagram";
export type SaveMode = "video" | "audio";
export type VideoQuality = "1080" | "720" | "480";

export type PrepareResult = {
  id: string;
  filename: string;
  source: MediaSource;
  mode: SaveMode;
  detail: string;
};

type Job = {
  upstream?: string;
  file?: string;
  filename: string;
  mime: string;
  exp: number;
};

type JobStore = Map<string, Job>;

const globalStore = globalThis as typeof globalThis & { __downloaderPlusJobs?: JobStore };
if (!globalStore.__downloaderPlusJobs) globalStore.__downloaderPlusJobs = new Map();
const jobs = globalStore.__downloaderPlusJobs;

const COBALT_APIS = ["https://rue-cobalt.xenon.zone/"];

const PAGE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
  "instagr.am",
  "www.instagr.am",
]);

function ytdlpBin(): string | null {
  const candidates = [process.env.YTDLP_PATH, "/workspace/bin/yt-dlp", "/tmp/yt-dlp"].filter(
    (value): value is string => Boolean(value),
  );
  return candidates.find((path) => existsSync(path)) ?? null;
}

function ffmpegBin(): string | null {
  const candidates = [process.env.FFMPEG_PATH, "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"].filter(
    (value): value is string => Boolean(value),
  );
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function normalizePageUrl(raw: string): string {
  const trimmed = raw.trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed) throw new Error("Paste a YouTube or Instagram link first.");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("That doesn’t look like a link. Copy it from YouTube or Instagram and paste again.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only public web links are supported.");
  }
  const host = url.hostname.toLowerCase();
  if (!PAGE_HOSTS.has(host)) {
    throw new Error("Paste a YouTube video or an Instagram Reel link.");
  }
  url.protocol = "https:";
  url.hash = "";
  return url.toString();
}

export function detectSource(raw: string): MediaSource {
  const host = new URL(raw).hostname.toLowerCase();
  if (host.includes("instagram") || host === "instagr.am" || host.endsWith(".instagr.am")) {
    return "instagram";
  }
  return "youtube";
}

function publicError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : "Could not save that link.";
  if (/sign in to confirm|not a bot|login required|cookies/i.test(raw)) {
    return new Error("YouTube blocked this save from the server. Try again in a moment.");
  }
  if (/private|empty media|unavailable|not accessible/i.test(raw)) {
    return new Error("That Reel is private or unavailable. Public links only.");
  }
  if (/unsupported url/i.test(raw)) {
    return new Error("Paste a YouTube video or an Instagram Reel link.");
  }
  if (/timed out|timeout|aborted/i.test(raw)) {
    return new Error("That took too long. Try a shorter clip or a lower quality.");
  }
  if (/error\.api\.youtube\.login/i.test(raw)) {
    return new Error("YouTube refused this link just now. Try again.");
  }
  if (/error\.api\.content/i.test(raw) || /no_media|not.?found/i.test(raw)) {
    return new Error("No public video was found at that link.");
  }
  if (raw.startsWith("error.")) {
    return new Error("The save service couldn’t read that link. Try again.");
  }
  if (raw.length > 180) {
    return new Error("Could not save that link. Check that it is public, then try again.");
  }
  return new Error(raw);
}

function asciiName(filename: string): string {
  const cleaned = filename.replace(/[\r\n"]/g, "").replace(/[^\w.\- ()[\]]+/g, "_").trim();
  return (cleaned || "download").slice(0, 140);
}

function mimeFor(filename: string, mode: SaveMode): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".mp3") || mode === "audio") return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return "video/mp4";
}

function detailFor(filename: string, mode: SaveMode, quality: VideoQuality): string {
  const match = filename.match(/(\d{3,4}p)/i);
  if (mode === "audio") return "Audio only · MP3";
  if (match) return `Video · ${match[1].toLowerCase()}`;
  return quality === "1080" ? "Video · HD" : `Video · ${quality}p`;
}

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.exp > now) continue;
    jobs.delete(id);
    if (job.file) void unlink(job.file).catch(() => undefined);
  }
}

function remember(job: Omit<Job, "exp">): string {
  sweepJobs();
  const id = randomBytes(12).toString("hex");
  jobs.set(id, { ...job, exp: Date.now() + 4 * 60 * 1000 });
  return id;
}

function allowedUpstream(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "rue-cobalt.xenon.zone") return true;
  if (host.endsWith(".cdninstagram.com")) return true;
  if (host.endsWith(".fbcdn.net")) return true;
  if (host.endsWith(".googlevideo.com")) return true;
  return false;
}

type CobaltOk = { upstream: string; filename: string };

async function fromCobalt(pageUrl: string, mode: SaveMode, quality: VideoQuality): Promise<CobaltOk> {
  let last = "The save service is busy. Try again.";
  for (const api of COBALT_APIS) {
    try {
      const response = await fetch(api, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "DownloaderPlus/1.0",
        },
        body: JSON.stringify({
          url: pageUrl,
          videoQuality: quality,
          downloadMode: mode === "audio" ? "audio" : "auto",
          audioFormat: "mp3",
          audioBitrate: "320",
          youtubeVideoCodec: "h264",
          youtubeVideoContainer: "mp4",
          filenameStyle: "pretty",
        }),
        signal: AbortSignal.timeout(28000),
      });
      const data = (await response.json()) as {
        status?: string;
        url?: string;
        filename?: string;
        error?: { code?: string };
        picker?: { type?: string; url?: string }[];
      };
      if (data.status === "error") {
        last = data.error?.code || last;
        continue;
      }
      if (data.status === "picker") {
        const item = data.picker?.find((entry) => entry.type === "video" && entry.url) ?? data.picker?.find((entry) => entry.url);
        if (!item?.url || !allowedUpstream(item.url)) {
          last = "error.api.content.no_media";
          continue;
        }
        return { upstream: item.url, filename: data.filename || fallbackName(pageUrl, mode) };
      }
      if ((data.status === "tunnel" || data.status === "redirect") && data.url && allowedUpstream(data.url)) {
        return { upstream: data.url, filename: data.filename || fallbackName(pageUrl, mode) };
      }
      last = data.status === "local-processing" ? "error.api.content.needs_local" : last;
    } catch (error) {
      last = error instanceof Error ? error.message : last;
    }
  }
  throw new Error(last);
}

function fallbackName(pageUrl: string, mode: SaveMode): string {
  const source = detectSource(pageUrl);
  const ext = mode === "audio" ? "mp3" : "mp4";
  return `${source === "instagram" ? "reel" : "video"}.${ext}`;
}

async function fromYtDlp(pageUrl: string, mode: SaveMode, quality: VideoQuality): Promise<{ file: string; filename: string }> {
  const bin = ytdlpBin();
  if (!bin) throw new Error("Could not reach a save service, and the local saver is unavailable.");
  const ffmpeg = ffmpegBin();
  const dir = await mkdtemp(join(tmpdir(), "dlp-"));
  const cap = quality === "480" ? 854 : quality === "720" ? 1280 : 1920;
  const args = ["--no-warnings", "--no-playlist", "--no-mtime", "--restrict-filenames"];
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);
  if (mode === "audio") {
    args.push("-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push(
      "-f",
      `bv*[height<=${cap}][ext=mp4]+ba[ext=m4a]/bv*[height<=${cap}]+ba/b[height<=${cap}]/b`,
      "--merge-output-format",
      "mp4",
    );
  }
  args.push("-o", join(dir, "media.%(ext)s"), pageUrl);
  try {
    await execFileAsync(bin, args, { timeout: 150000, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const stderr = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: string }).stderr || "") : "";
    const message = stderr.split("\n").map((line) => line.trim()).filter(Boolean).pop() || "The local saver failed.";
    throw new Error(message.replace(/^ERROR:\s*/, ""));
  }
  const names = await readdir(dir);
  const fileName = names.find((name) => !name.endsWith(".part")) ?? names[0];
  if (!fileName) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("The saver finished without a file.");
  }
  const file = join(dir, fileName);
  const info = await stat(file);
  if (info.size < 800) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("The file came back empty. Try another quality.");
  }
  const source = detectSource(pageUrl);
  const ext = fileName.split(".").pop() || (mode === "audio" ? "mp3" : "mp4");
  return { file, filename: `${source === "instagram" ? "reel" : "video"}.${ext}` };
}

export async function prepareDownload(input: {
  url: string;
  mode: SaveMode;
  quality: VideoQuality;
}): Promise<PrepareResult> {
  const url = normalizePageUrl(input.url);
  const source = detectSource(url);
  const mode = input.mode;
  const quality = input.quality;
  try {
    try {
      const remote = await fromCobalt(url, mode, quality);
      const filename = remote.filename;
      const id = remember({
        upstream: remote.upstream,
        filename,
        mime: mimeFor(filename, mode),
      });
      return { id, filename, source, mode, detail: detailFor(filename, mode, quality) };
    } catch (remoteError) {
      try {
        const local = await fromYtDlp(url, mode, quality);
        const id = remember({
          file: local.file,
          filename: local.filename,
          mime: mimeFor(local.filename, mode),
        });
        return {
          id,
          filename: local.filename,
          source,
          mode,
          detail: detailFor(local.filename, mode, quality),
        };
      } catch (localError) {
        const localMsg = localError instanceof Error ? localError.message : "";
        if (/403|forbidden|sign in|unavailable|local saver/i.test(localMsg)) throw remoteError;
        throw localError;
      }
    }
  } catch (error) {
    throw publicError(error);
  }
}

function disposition(filename: string): string {
  const ascii = asciiName(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function streamJob(id: string): Promise<Response> {
  sweepJobs();
  const job = jobs.get(id);
  if (!job) throw new Error("This save expired. Tap save again.");
  const headers = new Headers({
    "Content-Type": job.mime,
    "Content-Disposition": disposition(job.filename),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });

  if (job.file) {
    const info = await stat(job.file);
    headers.set("Content-Length", String(info.size));
    const node = createReadStream(job.file);
    const body = Readable.toWeb(node) as ReadableStream;
    const cleanup = () => {
      jobs.delete(id);
      const dir = job.file ? join(job.file, "..") : "";
      if (dir) void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };
    node.on("close", cleanup);
    node.on("error", cleanup);
    return new Response(body, { status: 200, headers });
  }

  if (!job.upstream || !allowedUpstream(job.upstream)) {
    throw new Error("The file link was rejected. Tap save again.");
  }
  const upstream = await fetch(job.upstream, {
    redirect: "follow",
    headers: { "User-Agent": "DownloaderPlus/1.0", Accept: "*/*" },
    signal: AbortSignal.timeout(120000),
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error("The file host refused the download. Tap save again.");
  }
  const length = upstream.headers.get("content-length");
  if (length) headers.set("Content-Length", length);
  jobs.delete(id);
  return new Response(upstream.body, { status: 200, headers });
}

export function errorPage(message: string): Response {
  const safe = message.replace(/[&<>]/g, (char) => ({ "&": "&", "<": "<", ">": ">" })[char] || char);
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DownloaderPlus</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f1e8;color:#1c1915;font-family:Outfit,system-ui,sans-serif;padding:24px"><main style="max-width:26rem"><p style="letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:#8a5410">DownloaderPlus</p><h1 style="font-family:Georgia,serif;font-size:1.8rem;line-height:1.2;margin:8px 0 12px">Couldn’t save that one</h1><p style="color:#74685a;margin:0 0 20px">${safe}</p><a href="/" style="display:inline-flex;min-height:48px;align-items:center;padding:0 18px;border-radius:999px;background:#1c1915;color:#f6f1e8;text-decoration:none">Back</a></main></body></html>`;
  return new Response(html, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
