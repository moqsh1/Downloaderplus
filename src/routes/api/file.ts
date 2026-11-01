import { createFileRoute } from "@tanstack/react-router";
import { errorPage, streamJob } from "@/lib/media.server";

export const Route = createFileRoute("/api/file")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") || "";
        try {
          if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("This save expired. Tap save again.");
          return await streamJob(id);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not start the download.";
          return errorPage(message);
        }
      },
    },
  },
});
