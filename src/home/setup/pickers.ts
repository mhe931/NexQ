import { open } from "@tauri-apps/plugin-dialog";

export const SUPPORTED_EXTENSIONS = ["md", "txt", "pdf", "docx", "pptx"];

/** Files chosen in the system dialog (empty when cancelled). */
export async function pickFiles(extensions: string[] = SUPPORTED_EXTENSIONS): Promise<string[]> {
  const selected = await open({ multiple: true, filters: [{ name: "Documents", extensions }] });
  if (selected == null) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** One file chosen in the system dialog (null when cancelled). */
export async function pickFile(name: string, extensions: string[]): Promise<string | null> {
  const selected = await open({ multiple: false, filters: [{ name, extensions }] });
  if (selected == null) return null;
  return Array.isArray(selected) ? (selected[0] ?? null) : selected;
}

export const PRESENTATION_EXTENSIONS = ["pptx", "pptm", "ppsx"];
export const NOTES_EXTENSIONS = ["docx", "pdf", "txt", "md"];

/** A folder chosen in the system dialog (null when cancelled). */
export async function pickFolder(title: string): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title });
  return typeof selected === "string" ? selected : null;
}

export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
