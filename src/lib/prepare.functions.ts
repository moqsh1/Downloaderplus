import { createServerFn } from "@tanstack/react-start";
import { prepareDownload, type SaveMode, type VideoQuality } from "@/lib/media.server";

export const prepareSave = createServerFn({ method: "POST" })
  .validator((data: { url: string; mode: SaveMode; quality: VideoQuality }) => {
    const url = typeof data?.url === "string" ? data.url : "";
    const mode: SaveMode = data?.mode === "audio" ? "audio" : "video";
    const quality: VideoQuality = data?.quality === "720" || data?.quality === "480" ? data.quality : "1080";
    return { url, mode, quality };
  })
  .handler(async ({ data }) => prepareDownload(data));
