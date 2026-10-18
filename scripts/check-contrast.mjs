#!/usr/bin/env node
/**
 * check-contrast.mjs — WCAG contrast for every colour role in styles.css.
 *
 *   node scripts/check-contrast.mjs
 *
 * Converts the oklch() token values to sRGB directly (OKLab -> linear sRGB)
 * rather than trusting a browser to resolve them, then reports each pairing
 * that actually appears on the page. Exits 1 if anything fails AA.
 */

import { readFile } from "node:fs/promises";

const MIN_BODY = 4.5; // normal text
const MIN_LARGE = 3.0; // large text and UI boundaries

/* ------------------------------------------------------- oklch -> sRGB */

function oklchToLinearRgb(l, c, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;

  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}

const encode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp = (v) => Math.min(1, Math.max(0, v));

function parseOklch(text) {
  const m = String(text).match(
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)/,
  );
  if (!m) return null;
  return { l: +m[1], c: +m[2], h: +m[3], alpha: m[4] === undefined ? 1 : +m[4] };
}

const luminance = ({ l, c, h }) =>
  oklchToLinearRgb(l, c, h).reduce((sum, v, i) => sum + [0.2126, 0.7152, 0.0722][i] * clamp(v), 0);

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

function toHex(token) {
  const rgb = oklchToLinearRgb(token.l, token.c, token.h).map((v) => Math.round(clamp(encode(v)) * 255));
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/* ------------------------------------------------------------- the check */

const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

// The light values live in :root, the dark ones in the prefers-color-scheme block.
const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)"));
const darkBlock = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));

function readTokens(block) {
  const tokens = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(oklch\([^)]*\))/g)) {
    const parsed = parseOklch(m[2]);
    if (parsed) tokens[m[1]] = parsed;
  }
  return tokens;
}

const themes = {
  light: readTokens(rootBlock),
  dark: { ...readTokens(rootBlock), ...readTokens(darkBlock) },
};

/** Every pairing that actually renders, and the threshold it must clear. */
const PAIRS = [
  ["page text", "text", "bg", MIN_BODY],
  ["headline rest", "text-2", "bg", MIN_BODY],
  ["meta + rail", "text-muted", "bg", MIN_BODY],
  ["inactive tab", "text-2", "bg", MIN_BODY],
  ["accent link", "accent-ink", "bg", MIN_BODY],
  ["button label", "on-accent", "accent", MIN_BODY],
  ["hero title", "hero-text", "hero-bg", MIN_BODY],
  ["hero lede", "hero-muted", "hero-bg", MIN_BODY],
  ["tile mark", "tile-ink", "tile", MIN_BODY],
  // The plate's label is 11px, so it needs the body minimum, and it is the only
  // place accent-ink sits on the tile rather than on the page.
  ["tile kind", "accent-ink", "tile", MIN_BODY],
  // The monogram on a card with no picture is 1.75rem and bold, so it is large
  // text; the detail under it is not, and keeps the body minimum.
  ["tile monogram", "text-2", "tile", MIN_LARGE],
  ["warning", "warning", "bg", MIN_BODY],
  ["danger", "danger", "bg", MIN_BODY],
  // The header clock. These are graphic objects rather than text, so they are held
  // to the 3:1 floor for non-text content — and each one already clears the
  // stricter text floor above, since the clock reuses the page's own tokens
  // rather than inventing its own. Its bezel is deliberately not listed: it is a
  // `--rule` hairline, like every other border on this page, and the dial is
  // defined by its marks and hands rather than by its outline.
  ["clock hour hand", "text", "bg", MIN_LARGE],
  ["clock minute hand", "text-2", "bg", MIN_LARGE],
  ["clock second hand", "accent-ink", "bg", MIN_LARGE],
  ["clock marks", "text-muted", "bg", MIN_LARGE],
];

let failures = 0;

for (const [themeName, tokens] of Object.entries(themes)) {
  console.log(`\n${themeName}`);
  console.log(`${"role".padEnd(16)} ${"fg".padEnd(9)} ${"bg".padEnd(9)} ratio   min   result`);
  for (const [label, fgKey, bgKey, min] of PAIRS) {
    const fg = tokens[fgKey];
    const bg = tokens[bgKey];
    if (!fg || !bg) {
      console.log(`${label.padEnd(16)} missing token (${fgKey} / ${bgKey})`);
      failures += 1;
      continue;
    }
    const ratio = contrast(fg, bg);
    const ok = ratio >= min;
    if (!ok) failures += 1;
    console.log(
      `${label.padEnd(16)} ${toHex(fg).padEnd(9)} ${toHex(bg).padEnd(9)} ` +
        `${ratio.toFixed(2).padStart(5)} ${min.toFixed(1).padStart(5)}   ${ok ? "pass" : "FAIL"}`,
    );
  }
}

console.log(failures === 0 ? "\nAll pairings pass.\n" : `\n${failures} pairings failed.\n`);

// Every token as sRGB, for authoring the fallback block that older engines use.
for (const [themeName, tokens] of Object.entries(themes)) {
  console.log(`${themeName} palette`);
  for (const [name, token] of Object.entries(tokens)) {
    console.log(`  --${name}: ${toHex(token)};`);
  }
}

process.exit(failures === 0 ? 0 : 1);
