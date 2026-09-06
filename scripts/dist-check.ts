/**
 * Run the built bundle, not the source.
 *
 * Every other check here executes TypeScript through vite-node. That misses
 * anything introduced by the production build itself — minification, the JSON
 * import, an asset path that only resolves under `base`. This project has
 * already shipped one bug of that shape: the site returned 200 while the build
 * was broken, because what was verified was never what was served.
 *
 *   npx vite-node scripts/dist-check.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const dist = new URL('../dist/', import.meta.url);
const html = readFileSync(new URL('index.html', dist), 'utf8');
const assets = readdirSync(new URL('assets/', dist));
const js = assets.filter((f) => f.endsWith('.js'));
const css = assets.filter((f) => f.endsWith('.css'));

const problems: string[] = [];
const bundle = js
  .map((f) => readFileSync(new URL(`assets/${f}`, dist), 'utf8'))
  .join('\n');

console.log(`index.html   ${(html.length / 1024).toFixed(1)} KB`);
console.log(`js           ${js.length} file(s), ${(bundle.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`css          ${css.length} file(s)`);

// The bundle must actually contain the app, not just a loader.
for (const [what, needle] of [
  ['feedback marks', 'fb__btn'],
  ['feedback store key', 'segue.feedback.v1'],
  ['debug panel', 'debug__offer'],
  ['priced tags', 'debug__tag'],
  ['search', 'searchtrigger'],
] as [string, string][]) {
  if (!bundle.includes(needle)) problems.push(`bundle is missing ${what} (${needle})`);
}

// Relative asset paths, so the same build serves a subpath or a custom domain.
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = m[1];
  if (url.startsWith('/')) problems.push(`absolute asset path "${url}" breaks subpath hosting`);
}

/*
 * Then actually execute it. A bundle that parses can still throw on first
 * render — the failure mode that matters, and the one a grep cannot see.
 */
const dom = new JSDOM(html, {
  url: 'https://jj-noonan.github.io/album-guide/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const g = dom.window as unknown as Record<string, unknown>;
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.scrollTo = () => {};
// Canvas and audio are absent in jsdom; the ambient layer touches both.
(dom.window as any).HTMLCanvasElement.prototype.getContext = () => null;
(dom.window as any).AudioContext = function () {
  return { createGain: () => ({ connect() {}, gain: { value: 0 } }), destination: {} };
};

const errors: string[] = [];
dom.window.addEventListener('error', (e: any) => errors.push(String(e.message ?? e)));

try {
  dom.window.eval(bundle);
} catch (e) {
  problems.push(`bundle threw on execution: ${(e as Error).message}`);
}

/*
 * React 18 renders through a scheduler, so #root is still empty the instant
 * eval returns. Checking immediately reports "the app did not render" for a
 * perfectly good build — let the queued work run first.
 */
await new Promise((r) => setTimeout(r, 1500));

const root = dom.window.document.getElementById('root');
const rendered = root?.innerHTML ?? '';
console.log(`rendered     ${rendered.length.toLocaleString()} chars into #root`);

if (rendered.length < 500) {
  problems.push(`#root has ${rendered.length} chars — the app did not render`);
}
for (const [what, sel] of [
  ['a jewel case', '.case'],
  ['the dial', '.dial'],
  ['feedback marks', '.fb__btn'],
] as [string, string][]) {
  if (root && root.querySelectorAll(sel).length === 0) {
    problems.push(`rendered page has no ${what} (${sel})`);
  }
}
/*
 * Every image the rendered page asks for must exist in the build.
 *
 * A broken src renders as a blank box rather than an error, so a rebrand that
 * renames assets can leave the logo missing and every check still green. This
 * caught nothing on the first run only because the paths were checked by hand;
 * it should not need checking by hand again.
 */
{
  const imgs = [...(root?.querySelectorAll('img') ?? [])]
    .map((el) => (el as HTMLImageElement).getAttribute('src') ?? '')
    .filter(Boolean);
  const missing = imgs.filter((src) => {
    if (/^(https?:|data:)/.test(src)) return false;
    return !existsSync(new URL(src.replace(/^\.\//, ''), dist));
  });
  console.log(`images:      ${imgs.length} referenced, ${missing.length} missing`);
  missing.forEach((m) => problems.push(`image not in build: ${m}`));
}

// The brand typeface has to be the one actually bundled, not a fallback.
{
  const cssFiles = assets.filter((f) => f.endsWith('.css'));
  const css = cssFiles
    .map((f) => readFileSync(new URL(`assets/${f}`, dist), 'utf8'))
    .join('\n');
  if (!/font-family:\s*['"]?Jost/i.test(css)) {
    problems.push('Jost is not declared in the bundled CSS');
  }
  const banned = ['Outfit', 'Playfair'];
  banned.forEach((f) => {
    if (css.includes(f)) problems.push(`${f} is still bundled — it breaks the logo's a`);
  });
}

errors.forEach((e) => problems.push(`runtime error: ${e}`));

console.log(problems.length ? `\nPROBLEMS:\n  ${problems.join('\n  ')}` : '\nDIST OK');
process.exit(problems.length ? 1 : 0);
