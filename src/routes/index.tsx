import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Clipboard, Clapperboard, Download, Music, CircleAlert } from "lucide-react";
import { prepareSave } from "@/lib/prepare.functions";

export const Route = createFileRoute("/")({ component: Home });

type Mode = "video" | "audio";
type Quality = "1080" | "720" | "480";

type HistoryItem = {
  url: string;
  title: string;
  mode: Mode;
  at: number;
};

const HISTORY_KEY = "downloaderplus.history";
const SAMPLE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

function youtubeId(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^[\w-]{6,}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      if (url.pathname === "/watch") {
        const id = url.searchParams.get("v");
        return id && /^[\w-]{6,}$/.test(id) ? id : null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if ((parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live") && parts[1]) {
        return /^[\w-]{6,}$/.test(parts[1]) ? parts[1] : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function sourceOf(input: string): "youtube" | "instagram" | null {
  try {
    const host = new URL(input.trim()).hostname.toLowerCase();
    if (host.includes("instagram") || host.endsWith("instagr.am")) return "instagram";
    if (host.includes("youtube") || host === "youtu.be" || host.endsWith(".youtu.be")) return "youtube";
  } catch {
    return null;
  }
  return null;
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.url === "string").slice(0, 6);
  } catch {
    return [];
  }
}

function Home() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("video");
  const [quality, setQuality] = useState<Quality>("1080");
  const [phase, setPhase] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [savedName, setSavedName] = useState("");
  const [detail, setDetail] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const source = sourceOf(url);
  const thumb = useMemo(() => {
    const id = youtubeId(url);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
  }, [url]);

  const canSave = Boolean(source) && phase !== "saving";

  async function pasteLink() {
    setMessage("");
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) throw new Error("empty");
      setUrl(text);
      setPhase("idle");
      setSavedName("");
    } catch {
      setPhase("error");
      setMessage("Clipboard is blocked. Tap the field and paste the link.");
    }
  }

  function remember(item: HistoryItem) {
    const next = [item, ...loadHistory().filter((entry) => entry.url !== item.url)].slice(0, 6);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    setHistory(next);
  }

  async function save() {
    if (!source) {
      setPhase("error");
      setMessage("Paste a YouTube or Instagram Reel link.");
      return;
    }
    setPhase("saving");
    setMessage("");
    setSavedName("");
    try {
      const result = await prepareSave({ data: { url: url.trim(), mode, quality } });
      setSavedName(result.filename);
      setDetail(result.detail);
      remember({ url: url.trim(), title: result.filename, mode, at: Date.now() });
      const link = document.createElement("a");
      link.href = `/api/file?id=${result.id}`;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setPhase("done");
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "Could not save that link.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col px-4 pt-8 pb-12">
      <header className="mb-8">
        <p className="text-xs font-medium tracking-[0.16em] text-brass-deep uppercase">Save it clean</p>
        <h1 className="font-display mt-2 text-4xl leading-none font-semibold text-balance text-ink">
          Downloader<span className="text-brass">Plus</span>
        </h1>
        <p className="mt-3 max-w-sm text-pretty text-muted">
          Paste a YouTube or Instagram Reel link. Save the HD video, or just the audio.
        </p>
      </header>

      <section className="rounded-card border border-line bg-card p-4 shadow-[0_16px_40px_-28px_rgba(28,25,21,0.45)]">
        <label htmlFor="link" className="text-sm font-medium text-ink">
          Link
        </label>
        <div className="mt-2 flex flex-col gap-2">
          <input
            id="link"
            value={url}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Paste a YouTube or Reel link"
            onChange={(event) => {
              setUrl(event.target.value);
              setPhase("idle");
              setMessage("");
              setSavedName("");
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text").trim();
              if (text) {
                setUrl(text);
                setPhase("idle");
                setSavedName("");
              }
            }}
            className="min-h-12 w-full rounded-xl border border-line bg-paper px-3 text-base text-ink outline-none placeholder:text-muted"
          />
          <button
            type="button"
            onClick={() => void pasteLink()}
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-line bg-paper px-4 text-sm font-medium text-ink"
          >
            <Clipboard className="size-4" aria-hidden="true" />
            Paste from clipboard
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-label="What to save">
          <ModeButton
            active={mode === "video"}
            label="HD video"
            hint="Picture and sound"
            onClick={() => setMode("video")}
            icon={<Clapperboard className="size-4" aria-hidden="true" />}
          />
          <ModeButton
            active={mode === "audio"}
            label="Audio only"
            hint="MP3, no picture"
            onClick={() => setMode("audio")}
            icon={<Music className="size-4" aria-hidden="true" />}
          />
        </div>

        {mode === "video" ? (
          <div className="mt-4">
            <p className="text-sm font-medium text-ink">Quality</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(["1080", "720", "480"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setQuality(value)}
                  className={
                    "min-h-11 rounded-xl border text-sm font-medium " +
                    (quality === value
                      ? "border-ink bg-ink text-paper"
                      : "border-line bg-paper text-ink")
                  }
                >
                  {value === "1080" ? "HD 1080" : `${value}p`}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {source ? (
          <article className="mt-4 overflow-hidden rounded-xl border border-line bg-paper">
            {thumb ? (
              <img
                src={thumb}
                alt=""
                className="aspect-video w-full object-cover"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : (
              <div className="flex aspect-[16/8] items-center justify-center text-brass-deep">
                {source === "instagram" ? (
                  <Clapperboard className="size-8" aria-hidden="true" />
                ) : (
                  <Download className="size-8" aria-hidden="true" />
                )}
              </div>
            )}
            <div className="flex items-center justify-between gap-3 px-3 py-3">
              <div>
                <p className="text-sm font-medium text-ink">
                  {source === "instagram" ? "Instagram Reel" : "YouTube"}
                </p>
                <p className="text-sm text-muted">
                  {mode === "audio" ? "Exports an MP3" : `Up to ${quality}p, with sound`}
                </p>
              </div>
              <span className="rounded-full bg-card px-2.5 py-1 text-xs font-medium tracking-wide text-brass-deep uppercase">
                {source === "instagram" ? "Reel" : "Video"}
              </span>
            </div>
          </article>
        ) : null}

        <button
          type="button"
          disabled={!canSave}
          onClick={() => void save()}
          className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brass px-4 text-base font-semibold text-ink disabled:opacity-50"
        >
          <Download className="size-4" aria-hidden="true" />
          {phase === "saving" ? "Preparing file…" : mode === "audio" ? "Save audio" : "Save HD video"}
        </button>

        {phase === "done" && savedName ? (
          <p className="mt-3 text-sm text-muted">
            Started <span className="font-medium text-ink">{savedName}</span>
            {detail ? ` · ${detail}` : ""}. On iPhone, look in Files or Downloads if it doesn’t open.
          </p>
        ) : null}
        {phase === "error" && message ? (
          <p className="mt-3 flex items-start gap-2 text-sm text-danger" role="alert">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{message}</span>
          </p>
        ) : null}
        {phase === "saving" ? (
          <p className="mt-3 text-sm text-muted">Fetching the best file. This can take a few seconds.</p>
        ) : null}
      </section>

      <button
        type="button"
        onClick={() => {
          setUrl(SAMPLE);
          setMode("video");
          setQuality("1080");
          setPhase("idle");
          setMessage("");
          setSavedName("");
        }}
        className="mt-4 self-start text-sm font-medium text-brass-deep underline decoration-line underline-offset-4"
      >
        Try a 19-second sample
      </button>

      {history.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-display text-xl font-semibold text-ink">Recent</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {history.map((item) => (
              <li key={`${item.at}-${item.url}`}>
                <button
                  type="button"
                  onClick={() => {
                    setUrl(item.url);
                    setMode(item.mode);
                    setPhase("idle");
                    setMessage("");
                    setSavedName("");
                  }}
                  className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-line bg-card px-3 text-left"
                >
                  <span className="truncate text-sm text-ink">{item.title}</span>
                  <span className="shrink-0 text-xs tracking-wide text-muted uppercase">
                    {item.mode === "audio" ? "Audio" : "Video"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-auto pt-8 text-sm text-pretty text-muted">
        Public videos and Reels only, for personal use. Please respect the creator.
      </p>
    </main>
  );
}

function ModeButton({
  active,
  label,
  hint,
  onClick,
  icon,
}: {
  active: boolean;
  label: string;
  hint: string;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        "flex min-h-16 flex-col items-start justify-center rounded-xl border px-3 text-left " +
        (active ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink")
      }
    >
      <span className="inline-flex items-center gap-2 text-sm font-medium">
        {icon}
        {label}
      </span>
      <span className={active ? "text-xs text-paper/80" : "text-xs text-muted"}>{hint}</span>
    </button>
  );
}
