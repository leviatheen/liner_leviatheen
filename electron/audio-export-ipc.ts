import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { handleTrusted } from "./ipc-guard.js";

const MAX_EXPORT_BYTES = 200 * 1024 * 1024;

interface AudioExportInput {
  suggestedName: string;
  extension: string;
  mimeType: string;
  bytes: Uint8Array;
}

function parseInput(value: unknown): AudioExportInput | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.suggestedName !== "string" ||
    typeof raw.extension !== "string" ||
    !/^[a-z0-9]{1,8}$/i.test(raw.extension) ||
    typeof raw.mimeType !== "string" ||
    !raw.mimeType.startsWith("audio/") ||
    !(raw.bytes instanceof Uint8Array) ||
    raw.bytes.byteLength === 0 ||
    raw.bytes.byteLength > MAX_EXPORT_BYTES
  )
    return null;

  const name = path
    .basename(raw.suggestedName)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
  if (!name) return null;

  return {
    suggestedName: name.toLowerCase().endsWith(`.${raw.extension.toLowerCase()}`)
      ? name
      : `${name}.${raw.extension.toLowerCase()}`,
    extension: raw.extension.toLowerCase(),
    mimeType: raw.mimeType,
    bytes: raw.bytes,
  };
}

export function setupAudioExport() {
  handleTrusted("audio:save-as", async (event, input: unknown) => {
    const parsed = parseInput(input);
    if (!parsed) throw new Error("Invalid audio export request");

    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(app.getPath("music"), parsed.suggestedName),
      buttonLabel: "Save",
      filters: [
        {
          name: "Audio",
          extensions: [parsed.extension],
        },
      ],
    };
    const chosen = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);
    if (chosen.canceled || !chosen.filePath) return "canceled";

    await fs.writeFile(chosen.filePath, parsed.bytes);
    return "saved";
  });
}
