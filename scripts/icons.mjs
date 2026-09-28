// Renders static/icons/*.svg to the PNG sizes Chrome needs. Run: node scripts/icons.mjs
// Needs Playwright's Chromium (not a project dependency): PLAYWRIGHT=path/to/playwright node scripts/icons.mjs
import { readFileSync } from "node:fs";
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  // Tiny sizes use a simplified drawing so the fingerprint stays readable.
  const svg = readFileSync(`static/icons/${size <= 32 ? "icon-small" : "icon"}.svg`, "utf8");
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
  );
  await page.screenshot({ path: `static/icons/icon-${size}.png`, omitBackground: true });
}
await browser.close();
