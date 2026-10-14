// Build-time step (npm "prebuild"): puts the static data the globe needs into
// public/data so the app serves it itself instead of depending, at runtime, on
// jsDelivr and raw.githubusercontent.com being up and not rate-limiting us.
//
// Safe by construction:
//  - Every downloaded file is verified against a pinned SHA-256 of the exact
//    bytes this app was tested with; a mismatch means the file is NOT used.
//  - It never fails the build. If a file cannot be produced, the app simply
//    falls back to the public CDN URL at runtime (see lib/assets.ts).
//  - It is idempotent: a file already present with the right hash is kept.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'data');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Downloads: pinned by content hash. The ISO table is also pinned to a commit.
const DOWNLOADS = [
  {
    name: 'PB2002_plates.json',
    url: 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json',
    sha256: '922918f970baf7e645821a4a728b945dbb5eeac1337d71d087fba021bcc79e21',
  },
  {
    name: 'PB2002_boundaries.json',
    url: 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json',
    sha256: '42b3e0876a7e40f133e958ba7ab85f8851b5c693a046fbc3b138e7751863d92a',
  },
  {
    name: 'iso-3166.json',
    url: 'https://raw.githubusercontent.com/lukes/ISO-3166-Countries-with-Regional-Codes/145f1ad3caff212ed25f42b0ee2c8b92a75af895/all/all.json',
    sha256: 'e1434e42786484b1841082a0a16cf27208691443dc6440d125ad81d49007ea42',
  },
];

// Copies from npm packages already installed for the build.
const COPIES = [
  {
    name: 'countries-110m.json',
    from: 'node_modules/world-atlas/countries-110m.json',
    sha256: '2516c915867c7baf18ddec727aec46c315541a07cfb3d79a6559b05d5e94eee8',
  },
  { name: 'earth-dark.jpg', from: 'node_modules/three-globe/example/img/earth-dark.jpg' },
];

async function readIfExists(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError;
}

async function ensure({ name, sha256: expected }, produce) {
  const target = join(outDir, name);
  const existing = await readIfExists(target);
  if (existing && (!expected || sha256(existing) === expected)) return 'kept';

  const data = await produce();
  if (expected && sha256(data) !== expected) {
    throw new Error(`hash distinto del esperado (${sha256(data).slice(0, 12)}…); no se usa`);
  }
  await writeFile(target, data);
  return 'written';
}

await mkdir(outDir, { recursive: true });

const results = [];
for (const item of DOWNLOADS) {
  try {
    results.push([item.name, await ensure(item, () => download(item.url))]);
  } catch (err) {
    results.push([item.name, `omitido: ${err instanceof Error ? err.message : err}`]);
  }
}
for (const item of COPIES) {
  try {
    results.push([item.name, await ensure(item, () => readFile(join(root, item.from)))]);
  } catch (err) {
    results.push([item.name, `omitido: ${err instanceof Error ? err.message : err}`]);
  }
}

const ok = results.filter(([, r]) => r === 'kept' || r === 'written').length;
for (const [name, r] of results) console.log(`[assets] ${name}: ${r}`);
console.log(`[assets] ${ok}/${results.length} archivos listos en public/data (el resto se carga desde la CDN)`);
// Always exit 0: missing assets degrade to CDN, they never break the build.
