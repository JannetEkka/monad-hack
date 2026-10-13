// The deck's product screenshot: the live page with a graded receipt open and verified.
//   node shot-detail.mjs <pageUrl> <out.png>
import { chromium } from "playwright";

const [pageUrl, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(pageUrl, { waitUntil: "networkidle" });
await page.waitForSelector(".slip", { timeout: 30000 });
const graded = page.locator(".line:has(.res.HIT), .line:has(.res.MISS)").first();
if (!(await graded.count())) {
  console.log("no graded receipt on the page yet: keeping the old screenshot");
  await browser.close();
  process.exit(0);
}
await graded.scrollIntoViewIfNeeded();
await graded.click();
await page.click("#verifyBtn");
await page.waitForSelector("#checks li.ok", { timeout: 20000 });
await page.waitForTimeout(800);
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
