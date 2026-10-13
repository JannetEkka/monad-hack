// Records the demo: the live page, one graded receipt + in-browser verify, its seal and grade
// transactions decoded from Monad's RPC, the held-positions tab, the keeper's public archive commits. Each scene lasts as long as its narration;
// scene start offsets go to offsets.json so the audio is laid at exactly those moments.
//   node record.mjs <pageUrl> <archiveCommitsUrl> <audioDir> <outDir>
import { chromium } from "playwright";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const [pageUrl, archiveUrl, audioDir, outDir] = process.argv.slice(2);
const dur = (i) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path.join(audioDir, `scene${String(i).padStart(2, "0")}.mp3`)]).toString());
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir: outDir, size: { width: 1280, height: 720 } } });
const page = await ctx.newPage();
const t0 = Date.now();
const offsets = [];
const hold = async (i, during) => {
  offsets.push((Date.now() - t0) / 1000);
  const end = Date.now() + dur(i) * 1000 + 600;
  if (during) await during();
  const left = end - Date.now();
  if (left > 0) await page.waitForTimeout(left);
};
// scroll a section to just under the sticky header
const smooth = (sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 76, behavior: "smooth" });
  }, sel);

await page.goto(pageUrl, { waitUntil: "networkidle" });
await page.waitForSelector(".slip, .empty", { timeout: 30000 });
await page.waitForTimeout(1200);
await hold(1);
await hold(2, async () => { await smooth("#scoreboard"); });
await hold(3, async () => { await smooth("#feed"); await page.waitForTimeout(3500); await page.mouse.wheel(0, 260); });
await hold(4, async () => {
  const graded = page.locator(".line:has(.res.HIT), .line:has(.res.MISS)").first();
  const target = (await graded.count()) ? graded : page.locator(".line:has(.dir.LONG), .line:has(.dir.SHORT)").first();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await target.click();
});
await hold(5, async () => {
  await page.click("#verifyBtn");
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const d = document.querySelector("#detail"); d.scrollTo({ top: d.scrollHeight, behavior: "smooth" }); });
});
await hold(6, async () => {
  await page.click("#chainBtn");
  await page.waitForSelector("#chain:not([hidden])");
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const d = document.querySelector("#detail"); d.scrollTo({ top: d.scrollHeight, behavior: "smooth" }); });
});
await hold(7, async () => {
  // the second record: SMT's held positions, on their own tab
  await page.keyboard.press("Escape");
  await smooth("#scoreboard");
  await page.waitForTimeout(1200);
  await page.click('#agents button[data-a="2"]');
  await page.waitForFunction(() => document.querySelector(".slip .meta")?.textContent.includes("account read"), null, { timeout: 30000 });
  await page.waitForTimeout(3500);
  await smooth("#feed");
  await page.waitForTimeout(2500);
  await page.mouse.wheel(0, 220);
});
await hold(8, async () => {
  await page.goto(archiveUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // the archive branch's history: one "archive: batch N" commit per seal (an Actions run's
  // job summary is only shown to signed-in GitHub users, the commit list to everyone)
  for (let k = 0; k < 3; k++) { await page.waitForTimeout(1800); await page.mouse.wheel(0, 160); }
});
await hold(9, async () => { await page.goto(pageUrl, { waitUntil: "networkidle" }); });
const video = await page.video().path();
await ctx.close();
await browser.close();
fs.writeFileSync(path.join(outDir, "offsets.json"), JSON.stringify({ video, offsets }, null, 1));
console.log(JSON.stringify({ video, offsets }));
