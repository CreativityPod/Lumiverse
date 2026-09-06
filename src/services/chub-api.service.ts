import { safeFetch } from "../utils/safe-fetch";

const CHUB_API_BASES = ["https://gateway.chub.ai/api", "https://api.chub.ai/api"];

export async function fetchChubJson(path: string): Promise<Record<string, any>> {
  let lastStatus = 0;
  for (const base of CHUB_API_BASES) {
    const res = await safeFetch(`${base}/${path}`, {
      timeoutMs: 15_000,
      maxBytes: 100 * 1024 * 1024,
      headers: { Accept: "application/json", "User-Agent": "Lumiverse" },
    });
    if (res.ok) return await res.json() as Record<string, any>;
    lastStatus = res.status;
  }
  throw new Error(`Chub API returned ${lastStatus || "no response"}`);
}

export function extractChubGalleryUrls(data: unknown): string[] {
  const nodes = Array.isArray((data as { nodes?: unknown })?.nodes)
    ? (data as { nodes: unknown[] }).nodes
    : [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;

    const candidate =
      typeof (node as { primary_image_path?: unknown }).primary_image_path === "string"
        ? (node as { primary_image_path: string }).primary_image_path
        : typeof (node as { image_path?: unknown }).image_path === "string"
          ? (node as { image_path: string }).image_path
          : typeof (node as { url?: unknown }).url === "string"
            ? (node as { url: string }).url
            : null;

    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    urls.push(candidate);
  }

  return urls;
}

export async function fetchChubGalleryUrls(projectId: unknown): Promise<string[]> {
  if (!projectId) return [];
  try {
    const data = await fetchChubJson(`gallery/project/${projectId}`);
    return extractChubGalleryUrls(data);
  } catch {
    return [];
  }
}

export interface ChubExpressionAsset {
  /** Expression name as the pack author wrote it, e.g. "joy", "embarrassment". */
  label: string;
  url: string;
}

/**
 * Pull a character's expression pack out of the card payload.
 *
 * Chub's UI offers expression packs as a separate authenticated zip download,
 * which made these look unreachable — but the labelled image URLs are already
 * present in the `?full=true` response the importer fetches, and the images
 * themselves are public. Nothing extra is requested and no credentials are
 * involved; this only reads a branch of the payload that was previously passed
 * through untouched.
 */
export function extractChubExpressionAssets(node: unknown): ChubExpressionAsset[] {
  const definition = (node as { definition?: unknown })?.definition;
  const chub = (definition as { extensions?: { chub?: unknown } })?.extensions?.chub;
  // The outer object also carries `version`, `is_default` and a `compressed`
  // field; only the inner label→URL map is needed, so an unfamiliar shape
  // around it costs nothing as long as that map is readable.
  const mappings = (chub as { expressions?: { expressions?: unknown } })?.expressions?.expressions;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return [];

  const assets: ChubExpressionAsset[] = [];
  const seen = new Set<string>();
  for (const [label, value] of Object.entries(mappings as Record<string, unknown>)) {
    const trimmed = label.trim();
    if (!trimmed || typeof value !== "string") continue;
    const url = value.trim();
    // Only absolute https URLs — a relative or data URI here would be
    // unexpected, and safeFetch would reject it downstream anyway.
    if (!url.toLowerCase().startsWith("https://")) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    assets.push({ label: trimmed, url });
  }
  return assets;
}
