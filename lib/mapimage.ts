import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DotaError } from "./errors.ts";

/**
 * A minimap picture the user saves into the skill folder for the dashboard map. It is
 * game art, so it is never shipped with the skill: the file is git-ignored and stays
 * on the user's computer.
 */
const DIR = typeof Bun === "undefined" ? "" : join(import.meta.dir, "..");
const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;
type Ext = keyof typeof TYPES;
const MAX_BYTES = 10 * 1024 * 1024;

/** Which map cells the picture's edges sit on (OpenDota cells: x left to right, y bottom to top). */
export interface MapBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
}
// Fitted to a 1024px top-down "simplemap" picture with a ~60px empty margin (Liquipedia's
// Gamemap simplemap style): the edges that put ~1,400 observer and sentry placements from 12
// parsed pro matches on walkable, non-river ground. A different picture needs its own edges.
export const DEFAULT_BOUNDS: MapBounds = { left: 54.5, right: 201, bottom: 56, top: 202 };

const fileFor = (ext: Ext) => join(DIR, `map.${ext}`);

export function findMapImage(): { file: string; type: string } | null {
  for (const ext of Object.keys(TYPES) as Ext[]) if (existsSync(fileFor(ext))) return { file: fileFor(ext), type: TYPES[ext] };
  return null;
}

function sniff(buf: Uint8Array): Ext | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => buf[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (at(0, [0xff, 0xd8, 0xff])) return "jpg";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "webp";
  return null;
}

/** Decode a base64 PNG, JPEG or WebP (a data: URL or bare base64) and check its type. */
export function decodeMapImage(data: string): { bytes: Uint8Array; type: string; ext: Ext } {
  const b64 = data.replace(/^data:[^,]*,/, "");
  if (b64.length > (MAX_BYTES * 4) / 3 + 8) throw new DotaError("The image is over 10 MB.");
  const bytes = Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const ext = sniff(bytes);
  if (!ext) throw new DotaError("Use a PNG, JPEG or WebP image.");
  return { bytes, type: TYPES[ext], ext };
}

/** Save a base64 PNG, JPEG or WebP (a data: URL or bare base64), replacing any earlier picture. */
export function saveMapImage(data: string): string {
  const { bytes, ext } = decodeMapImage(data);
  const file = fileFor(ext);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  removeMapImage();
  renameSync(tmp, file);
  return file;
}

export function removeMapImage(): void {
  for (const ext of Object.keys(TYPES) as Ext[]) rmSync(fileFor(ext), { force: true });
}

export function readMapImage(): { body: Buffer; type: string } | null {
  const f = findMapImage();
  return f ? { body: readFileSync(f.file), type: f.type } : null;
}

export function validateBounds(raw: unknown): MapBounds {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out = {} as MapBounds;
  for (const k of ["left", "right", "bottom", "top"] as const) {
    const v = Number(o[k]);
    if (!Number.isFinite(v) || v < 0 || v > 256) throw new DotaError(`${k} must be a number between 0 and 256.`);
    out[k] = Math.round(v * 10) / 10;
  }
  if (out.right - out.left < 32 || out.top - out.bottom < 32) throw new DotaError("right must be above left and top above bottom by at least 32 cells.");
  return out;
}
