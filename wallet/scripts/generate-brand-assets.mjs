import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const walletDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(walletDir, "public");

const readFont = async (relativePath) =>
  `data:font/woff2;base64,${(await readFile(path.join(walletDir, relativePath))).toString("base64")}`;

const [displayFont, sansRegularFont, sansSemiboldFont, monoFont, favicon] = await Promise.all([
  readFont("node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2"),
  readFont("node_modules/@fontsource/public-sans/files/public-sans-latin-400-normal.woff2"),
  readFont("node_modules/@fontsource/public-sans/files/public-sans-latin-600-normal.woff2"),
  readFont("node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2"),
  readFile(path.join(publicDir, "favicon.svg"), "utf8"),
]);

await mkdir(publicDir, { recursive: true });

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "chrome" });
  } catch (systemChromeError) {
    try {
      return await chromium.launch();
    } catch (bundledChromiumError) {
      throw new AggregateError(
        [systemChromeError, bundledChromiumError],
        "Asset generation needs either system Chrome or Playwright Chromium.",
      );
    }
  }
}

const browser = await launchBrowser();

async function renderIcon(size, filename, maskable = false) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const svg = maskable ? favicon.replace('rx="14"', 'rx="0"') : favicon;
  await page.setContent(`
    <!doctype html>
    <style>
      * { box-sizing: border-box; }
      html, body { width: ${size}px; height: ${size}px; margin: 0; background: transparent; }
      svg { display: block; width: ${size}px; height: ${size}px; }
    </style>
    ${svg}
  `);
  await page.locator("svg").screenshot({ path: path.join(publicDir, filename), omitBackground: true });
  await page.close();
}

const mark = `
  <svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 8C45.2 8 56 19 56 35c0 17-10.8 21-24 21S8 52 8 35C8 19 18.8 8 32 8Z" fill="#f4dfd5" stroke="#b94a24" stroke-width="4"/>
    <path d="M32 17c7 5.6 11 12.5 11 19 0 7.5-4 13-11 17" fill="none" stroke="#0f5b43" stroke-linecap="round" stroke-width="4"/>
  </svg>
`;

const socialCard = `
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <style>
        @font-face { font-family: "Instrument Serif"; src: url("${displayFont}") format("woff2"); font-weight: 400; }
        @font-face { font-family: "Public Sans"; src: url("${sansRegularFont}") format("woff2"); font-weight: 400; }
        @font-face { font-family: "Public Sans"; src: url("${sansSemiboldFont}") format("woff2"); font-weight: 600; }
        @font-face { font-family: "IBM Plex Mono"; src: url("${monoFont}") format("woff2"); font-weight: 500; }
        :root {
          --canvas: #cdd6d2;
          --page: #f2f4f1;
          --surface: #ffffff;
          --ink: #18201c;
          --muted: #58645e;
          --border: #d2dad5;
          --primary: #0f5b43;
          --accent: #b94a24;
          --accent-soft: #f4dfd5;
          --settled-soft: #dcebdd;
        }
        * { box-sizing: border-box; }
        html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
        body { background: var(--page); color: var(--ink); font-family: "Public Sans", sans-serif; }
        .artboard { position: relative; width: 1200px; height: 630px; overflow: hidden; border: 18px solid var(--canvas); }
        .network-rail {
          height: 46px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 54px;
          background: var(--primary);
          color: var(--page);
          font: 500 14px/1 "IBM Plex Mono", monospace;
          text-transform: uppercase;
        }
        .network-rail__group { display: flex; align-items: center; gap: 16px; }
        .network-rail__slash { color: #e9b565; }
        .content { display: grid; grid-template-columns: 1fr 416px; gap: 62px; padding: 54px 64px 42px; }
        .wordmark { display: flex; align-items: center; gap: 18px; }
        .wordmark svg { width: 54px; height: 54px; flex: none; }
        .wordmark span { font: 400 54px/0.9 "Instrument Serif", serif; }
        .eyebrow {
          margin-top: 58px;
          color: var(--accent);
          font: 500 15px/1 "IBM Plex Mono", monospace;
          text-transform: uppercase;
        }
        h1 { margin: 15px 0 0; max-width: 600px; font: 400 76px/0.93 "Instrument Serif", serif; }
        .lede { max-width: 560px; margin: 22px 0 0; color: var(--muted); font-size: 20px; line-height: 1.45; }
        .chips { display: flex; gap: 10px; margin-top: 28px; }
        .chip {
          display: inline-flex;
          align-items: center;
          height: 34px;
          padding: 0 13px;
          border: 1px solid #b9c5be;
          border-radius: 5px;
          background: var(--surface);
          color: var(--primary);
          font: 500 13px/1 "IBM Plex Mono", monospace;
        }
        .receipt {
          align-self: center;
          overflow: hidden;
          border-radius: 14px;
          background: var(--primary);
          color: var(--page);
          box-shadow: 0 20px 42px rgba(18, 42, 34, 0.17);
          transform: rotate(1.25deg);
        }
        .receipt__stripe { display: grid; grid-template-columns: repeat(16, 1fr); height: 14px; background: #efc269; }
        .receipt__stripe span:nth-child(odd) { background: var(--accent); }
        .receipt__body { padding: 30px 32px 28px; }
        .receipt__head { display: flex; justify-content: space-between; font: 500 12px/1 "IBM Plex Mono", monospace; text-transform: uppercase; }
        .receipt__amount { margin-top: 39px; font: 400 74px/0.9 "Instrument Serif", serif; }
        .receipt__amount span { margin-left: 8px; font: 500 14px/1 "IBM Plex Mono", monospace; }
        .receipt__rule { margin: 30px 0 22px; border-top: 1px dashed rgba(242, 244, 241, 0.42); }
        .receipt__row { display: flex; justify-content: space-between; gap: 24px; margin-top: 13px; font-size: 14px; }
        .receipt__row span:first-child { color: #bed2c9; }
        .receipt__row span:last-child { font-weight: 600; text-align: right; }
        .receipt__status {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 28px;
          padding: 13px 15px;
          border-radius: 7px;
          background: var(--settled-soft);
          color: #23613f;
          font-size: 14px;
          font-weight: 600;
        }
        .receipt__check {
          display: grid;
          width: 24px;
          height: 24px;
          flex: none;
          place-items: center;
          border-radius: 50%;
          background: #23613f;
          color: white;
          font-size: 15px;
        }
        .footer {
          position: absolute;
          right: 64px;
          bottom: 30px;
          left: 64px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-top: 18px;
          border-top: 1px solid var(--border);
          color: var(--muted);
          font: 500 13px/1 "IBM Plex Mono", monospace;
        }
        .footer strong { color: var(--ink); font-weight: 500; }
      </style>
    </head>
    <body>
      <div class="artboard">
        <div class="network-rail">
          <div class="network-rail__group"><span>CKB Testnet</span><span class="network-rail__slash">/</span><span>RUSD ecash</span></div>
          <span>Cashu + Fiber Network</span>
        </div>
        <main class="content">
          <section>
            <div class="wordmark">${mark}<span>FiberNuts</span></div>
            <div class="eyebrow">Bearer payments</div>
            <h1>RUSD ecash,<br />made practical.</h1>
            <p class="lede">Mint funding and redemption settle through CKB's Fiber Network.</p>
            <div class="chips"><span class="chip">RUSD</span><span class="chip">CASHU</span><span class="chip">FIBER</span></div>
          </section>
          <section class="receipt" aria-label="Settled RUSD payment receipt">
            <div class="receipt__stripe">${"<span></span>".repeat(16)}</div>
            <div class="receipt__body">
              <div class="receipt__head"><span>Bearer receipt</span><span>CKB testnet</span></div>
              <div class="receipt__amount">2.50 <span>RUSD</span></div>
              <div class="receipt__rule"></div>
              <div class="receipt__row"><span>For</span><span>Coffee</span></div>
              <div class="receipt__row"><span>Issued by</span><span>CKB Meetup Test Mint</span></div>
              <div class="receipt__status"><span class="receipt__check">&#10003;</span><span>Settled with fresh proofs</span></div>
            </div>
          </section>
        </main>
        <footer class="footer"><strong>fibernuts.strawhatcrew.xyz</strong><span>BOUNDED CUSTODIAL TRUST</span></footer>
      </div>
    </body>
  </html>
`;

try {
  await Promise.all([
    renderIcon(32, "favicon-32.png"),
    renderIcon(96, "favicon-96.png"),
    renderIcon(180, "apple-touch-icon.png", true),
    renderIcon(192, "icon-192.png"),
    renderIcon(512, "icon-512.png"),
    renderIcon(512, "icon-maskable-512.png", true),
  ]);

  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(socialCard, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(publicDir, "social-card.png") });
  await page.close();
} finally {
  await browser.close();
}

console.log("Generated FiberNuts favicon, app icon, and social sharing assets.");
