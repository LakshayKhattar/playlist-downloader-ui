import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalUrl = 'https://playlist-downloader-ui.onrender.com/';

async function read(relativePath) {
  return fs.readFile(path.join(root, relativePath), 'utf8');
}

test('HTML exposes canonical metadata, social cards, structured data, and crawlable fallback text', async () => {
  const html = await read('index.html');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Playlist Downloader UI \| Secure yt-dlp Web Interface<\/title>/);
  assert.ok(html.includes(`<link rel="canonical" href="${canonicalUrl}"`));
  assert.ok(html.includes(`<meta property="og:url" content="${canonicalUrl}"`));
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="robots" content="index, follow/);
  assert.match(html, /<main class="seo-fallback">/);
  assert.match(html, /github\.com\/yt-dlp\/yt-dlp/);
  assert.match(html, /github\.com\/LakshayKhattar\/playlist-downloader-ui/);

  const jsonLd = html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)?.[1];
  assert.ok(jsonLd, 'JSON-LD block is missing.');
  const schema = JSON.parse(jsonLd);
  assert.equal(schema['@type'], 'WebApplication');
  assert.equal(schema.url, canonicalUrl);
  assert.equal(schema.isAccessibleForFree, true);
  assert.equal(schema.codeRepository, 'https://github.com/LakshayKhattar/playlist-downloader-ui');
});

test('crawler, sitemap, manifest, and favicon assets are internally consistent', async () => {
  const [robots, sitemap, manifestText, favicon] = await Promise.all([
    read('public/robots.txt'),
    read('public/sitemap.xml'),
    read('public/site.webmanifest'),
    read('public/favicon.svg'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Disallow: \/api\//);
  assert.ok(robots.includes(`Sitemap: ${canonicalUrl}sitemap.xml`));
  assert.ok(sitemap.includes(`<loc>${canonicalUrl}</loc>`));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.icons[0].src, '/favicon.svg');
  assert.match(favicon, /^<svg[^>]+viewBox="0 0 64 64"/);
});
