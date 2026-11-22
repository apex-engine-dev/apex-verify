// "checked by ReallyDone" README badge (issue #14). Turns the latest verify
// verdict into a Shields-compatible badge.json plus a ready-to-embed badge.svg,
// so a project can show the gate's verdict on its default branch. No network,
// no dependencies: the workflow just writes the two files to the `badge` branch.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type BadgeVerdict = "ready" | "not_ready" | "unknown";

export const BADGE_LABEL = "checked by ReallyDone";

const MESSAGES: Record<BadgeVerdict, string> = {
  ready: "ready",
  not_ready: "not ready",
  unknown: "unknown",
};

// Shields endpoint color names, mapped to the hex the static SVG needs.
const COLORS: Record<BadgeVerdict, { name: string; hex: string }> = {
  ready: { name: "brightgreen", hex: "#4c1" },
  not_ready: { name: "red", hex: "#e05d44" },
  unknown: { name: "lightgrey", hex: "#9f9f9f" },
};

/** Anything that is not a known verdict (including a failed run) reads as `unknown`. */
export function normalizeVerdict(verdict: unknown): BadgeVerdict {
  return verdict === "ready" || verdict === "not_ready" || verdict === "unknown" ? verdict : "unknown";
}

/** Shields endpoint JSON (https://shields.io/endpoint) for a verdict. */
export function badgeJson(verdict: unknown): string {
  const v = normalizeVerdict(verdict);
  return JSON.stringify(
    { schemaVersion: 1, label: BADGE_LABEL, message: MESSAGES[v], color: COLORS[v].name },
    null,
    2,
  ) + "\n";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shields-style flat badge. Text width is estimated (11px Verdana ≈ 7px/char +
// padding) — close enough for a static badge with a fixed label.
function textWidth(s: string): number {
  return s.length * 7 + 10;
}

/** A standalone SVG badge with the same content as badgeJson, for raw.githubusercontent embedding. */
export function badgeSvg(verdict: unknown): string {
  const v = normalizeVerdict(verdict);
  const label = BADGE_LABEL;
  const message = MESSAGES[v];
  const hex = COLORS[v].hex;
  const lw = textWidth(label);
  const mw = textWidth(message);
  const w = lw + mw;
  const title = escapeXml(`${label}: ${message}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${title}">\n` +
    `  <title>${title}</title>\n` +
    `  <linearGradient id="s" x2="0" y2="100%">\n` +
    `    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>\n` +
    `    <stop offset="1" stop-opacity=".1"/>\n` +
    `  </linearGradient>\n` +
    `  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>\n` +
    `  <g clip-path="url(#r)">\n` +
    `    <rect width="${lw}" height="20" fill="#555"/>\n` +
    `    <rect x="${lw}" width="${mw}" height="20" fill="${hex}"/>\n` +
    `    <rect width="${w}" height="20" fill="url(#s)"/>\n` +
    `  </g>\n` +
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">\n` +
    `    <text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>\n` +
    `    <text x="${lw / 2}" y="14">${escapeXml(label)}</text>\n` +
    `    <text x="${lw + mw / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>\n` +
    `    <text x="${lw + mw / 2}" y="14">${escapeXml(message)}</text>\n` +
    `  </g>\n` +
    `</svg>\n`
  );
}

/** The two files published on the badge branch. */
export function badgeFiles(verdict: unknown): Record<string, string> {
  return { "badge.json": badgeJson(verdict), "badge.svg": badgeSvg(verdict) };
}

// CLI: node dist/badge.js <verdict> <outdir> writes badge.json + badge.svg into <outdir>.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const verdict = process.argv[2] ?? "unknown";
  const outdir = process.argv[3] ?? ".";
  fs.mkdirSync(outdir, { recursive: true });
  for (const [name, content] of Object.entries(badgeFiles(verdict))) {
    fs.writeFileSync(path.join(outdir, name), content);
    console.log(`wrote ${path.join(outdir, name)} (verdict: ${normalizeVerdict(verdict)})`);
  }
}
