import type { Track } from "@/shared/types";
import { isLocalTrackId } from "@/shared/media/local";
import { resolvePlaybackStream } from "./streamResolver";
import { downloadAudioBytes } from "@/shared/youtube";
import { isStandaloneAudioFile } from "@/shared/storage/audioFormat";
import { linerDb } from "@/shared/storage";

export type SaveTrackAsResult = "saved" | "canceled";

const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

function safeBaseName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 160) || "track";
}

function extensionFor(mimeType: string): string {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (mime) {
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    case "audio/opus":
      return "opus";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/aac":
      return "aac";
    default:
      return "webm";
  }
}

async function getAudioBytes(track: Track): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}> {
  if (!isLocalTrackId(track.id)) {
    const cached = await linerDb.getAudio(track.id).catch(() => null);
    if (cached?.blob.size) {
      if (cached.blob.size > MAX_EXPORT_BYTES)
        throw new Error("Audio file is too large to export");
      const bytes = new Uint8Array(await cached.blob.arrayBuffer());
      if (isStandaloneAudioFile(bytes.subarray(0, 16))) {
        return {
          bytes,
          mimeType: cached.blob.type || cached.mimeType || "audio/webm",
        };
      }
    }
  }

  const stream = await resolvePlaybackStream(track, AbortSignal.timeout(120_000));
  try {
    let bytes: Uint8Array<ArrayBuffer> | null = null;
    let mimeType = stream.mimeType || stream.blob?.type || "";

    if (stream.blob) {
      bytes = new Uint8Array(await stream.blob.arrayBuffer());
    } else if (stream.completed) {
      const blob = await stream.completed;
      bytes = new Uint8Array(await blob.arrayBuffer());
      mimeType ||= blob.type;
    } else if (stream.url.startsWith("liner-local://") && !mimeType) {
      const response = await fetch(stream.url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (response.ok) {
        mimeType = response.headers.get("content-type") ?? "";
        bytes = new Uint8Array(await response.arrayBuffer());
      }
    } else {
      if (stream.contentLength && stream.contentLength > MAX_EXPORT_BYTES)
        throw new Error("Audio file is too large to export");
      bytes = await downloadAudioBytes(stream.url, {
        contentLength: stream.contentLength,
        signal: AbortSignal.timeout(120_000),
      });
    }

    if (!bytes?.byteLength) throw new Error("Audio download returned no data");
    if (bytes.byteLength > MAX_EXPORT_BYTES)
      throw new Error("Audio file is too large to export");
    if (!isStandaloneAudioFile(bytes.subarray(0, 16)))
      throw new Error("Audio stream is not a complete audio file");
    if (mimeType.startsWith("video/"))
      mimeType = mimeType.replace(/^video\//, "audio/");
    if (!mimeType.startsWith("audio/")) mimeType = "audio/webm";
    return { bytes, mimeType };
  } finally {
    stream.release?.();
  }
}

export async function saveTrackAs(track: Track): Promise<SaveTrackAsResult> {
  const { bytes, mimeType } = await getAudioBytes(track);
  const extension = extensionFor(mimeType);
  const suggestedName = `${safeBaseName(track.artists)} - ${safeBaseName(track.title)}.${extension}`;

  if (typeof window !== "undefined" && window.linerElectron?.saveAudioAs) {
    const result = await window.linerElectron.saveAudioAs({
      suggestedName,
      extension,
      mimeType,
      bytes,
    });
    return result === "saved" ? "saved" : "canceled";
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return "saved";
}
