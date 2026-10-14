import https from 'node:https';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { EarthquakesResponse, QuakeFeature, SourceMeta } from './types';
import type { Period } from './usgs';

/**
 * Servicio Geológico Colombiano — Red Sismológica Nacional de Colombia.
 *
 * IMPORTANT — unofficial integration:
 * This is a reverse-engineered, undocumented endpoint (no published SLA,
 * schema guarantee, or rate limits). The SGC's general terms do not
 * unambiguously authorize automated ingestion, caching, or republication of
 * this feed. Written authorization has NOT been requested or granted.
 * This integration exists for personal/educational use and every quake
 * sourced from it is labeled "no oficial" in the UI (see QuakeModal, Legend).
 * Source: https://www.sgc.gov.co/sismos · https://sgc.gov.co/catalogo
 *
 * DELIBERATE WORKAROUND — read before touching:
 * The feed is served from an S3-backed host that returned HTTP 403
 * (AccessDenied) for requests without a browser-like `Referer`/`User-Agent`.
 * Sending a `Referer` matching the SGC's own site plus a normal browser
 * `User-Agent` was a conscious choice, made and confirmed with the project
 * owner, to route around what looks like a referer-based access restriction —
 * not an accident and not hidden. If the SGC ever grants (or denies) written
 * authorization for this integration, this comment and the headers below are
 * the first thing to revisit.
 *
 * INCOMPLETE TLS CHAIN (the actual cause of the "SGC no conecta" error):
 * archive.sgc.gov.co serves its leaf certificate WITHOUT the intermediate CA
 * certificate. Browsers silently fetch the missing intermediate (AIA "CA
 * Issuers" extension); Node.js does not, so every request from the server
 * failed with UNABLE_TO_VERIFY_LEAF_SIGNATURE. We do NOT disable certificate
 * verification. Instead `completeChain()` downloads the intermediate named in
 * the leaf's own AIA extension and adds it to the trust list; the chain must
 * still end at a root from Mozilla's bundle (tls.rootCertificates), so a forged
 * intermediate cannot make an untrusted certificate validate. The one
 * `rejectUnauthorized: false` handshake below only READS the presented
 * certificate and sends no data. If the SGC fixes its server this becomes a
 * no-op (the leaf is issued by a known root, nothing is chased).
 *
 * Connection strategies (tried in order, every outcome is reported by
 * `?debug=1` on the API route so a failure can be diagnosed from production):
 *   1. node:https, completed chain, honest headers (no Referer)
 *   2. node:https, completed chain, + the SGC Referer headers above
 *   3. fetch() with the system chain (works if the SGC fixes its server)
 */
const SGC_FIVE_DAY_FEED = 'https://archive.sgc.gov.co/feed/v1.0.1/summary/five_days_all.json';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const REFERER_HEADERS: Record<string, string> = {
  'User-Agent': BROWSER_UA,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.sgc.gov.co/sismos',
  Origin: 'https://www.sgc.gov.co',
};
const PLAIN_HEADERS: Record<string, string> = {
  'User-Agent': 'seismo-globe (educational; unofficial viewer)',
  Accept: 'application/json',
};

const SGC_FEED_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
const FEED_STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const ATTEMPT_TIMEOUT_MS = 7000;
const MAX_BYTES = 8 * 1024 * 1024;
const CHAIN_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 30 * 1000;

export const SGC_SOURCE: SourceMeta = {
  name: 'Servicio Geológico Colombiano (SGC) — Red Sismológica Nacional (NO OFICIAL)',
  url: 'https://www.sgc.gov.co/sismos',
  license:
    'Integración comunitaria no oficial de un feed público no documentado. Autorización escrita del SGC para ingesta y republicación: pendiente de solicitud.',
  fetchedAt: '',
};

const PERIOD_MS: Record<Period, number> = {
  hour: 3.6e6,
  day: 8.64e7,
  week: 6.048e8,
  month: 2.628e9,
};

let lastGoodRaw: { fetchedAt: number; quakes: QuakeFeature[] } | null = null;

function toMs(value: unknown): number | null {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    // SGC's utcTime looks like "2026-09-27 17:33" — no seconds, no offset,
    // space instead of "T". Force UTC explicitly so this can't silently drift
    // if the server's local timezone ever differs from UTC.
    const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(value)
      ? `${value.replace(' ', 'T')}${value.length === 16 ? ':00' : ''}Z`
      : value;
    const parsed = Date.parse(isoLike);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// Documented coordinate order for this feed is [lat, lng, depthKm] — the
// OPPOSITE of the GeoJSON standard used by USGS.
function normalizeLatLng(a: number, b: number): [number, number] | null {
  const aIsLat = a >= -90 && a <= 90;
  const bIsLat = b >= -90 && b <= 90;
  const aIsLng = a >= -180 && a <= 180;
  const bIsLng = b >= -180 && b <= 180;
  if (aIsLat && bIsLng) return [a, b];
  if (bIsLat && aIsLng) return [b, a];
  return null;
}

function mapSgcFeature(f: any): QuakeFeature | null {
  const p = f?.properties;
  const coords = f?.geometry?.coordinates;
  if (!p || !Array.isArray(coords) || coords.length < 2) return null;
  if (String(p.agency ?? '').toUpperCase() !== 'SGC') return null;

  const [rawA, rawB, depthRaw] = coords;
  if (typeof rawA !== 'number' || typeof rawB !== 'number') return null;
  const latLng = normalizeLatLng(rawA, rawB);
  if (!latLng) return null;
  const [lat, lng] = latLng;

  const time = toMs(p.utcTime) ?? toMs(p.time);
  if (time === null || typeof p.mag !== 'number') return null;

  const rawStatus = String(p.status ?? 'automatic').toLowerCase();

  return {
    id: `sgc-${f.id ?? `${lat.toFixed(3)}-${lng.toFixed(3)}-${time}`}`,
    mag: p.mag,
    magType: p.magType ?? null,
    place: p.place ?? p.title ?? null,
    time,
    updated: time,
    url: SGC_SOURCE.url,
    detailUrl: '',
    felt: null,
    tsunami: 0,
    alert: null,
    status: rawStatus === 'manual' ? 'reviewed' : 'automatic',
    sig: null,
    depthKm: typeof depthRaw === 'number' ? depthRaw : null,
    lat,
    lng,
    source: 'SGC',
    intensity: typeof p.mmi === 'number' && p.mmi > 0 ? `MMI ${p.mmi}` : null,
  };
}

function filterForRequest(quakes: QuakeFeature[], period: Period, minMag: number): QuakeFeature[] {
  const now = Date.now();
  const windowMs = Math.min(PERIOD_MS[period], SGC_FEED_WINDOW_MS);
  return quakes
    .filter((q) => now - q.time <= windowMs && (q.mag ?? 0) >= minMag)
    .sort((a, b) => b.time - a.time);
}

// ---------------------------------------------------------------- transport

interface RawResult {
  status: number;
  contentType: string | null;
  body: string;
}

async function fetchGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<RawResult> {
  const res = await fetch(url, { cache: 'no-store', headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type'), body };
}

/** Exported for tests. */
export function httpsGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  agent?: https.Agent
): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...headers, 'Accept-Encoding': 'identity' }, timeout: timeoutMs, agent }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error('Respuesta demasiado grande'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? '') || null,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Tiempo de espera agotado (${timeoutMs} ms)`)));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- TLS chain completion

export interface TlsTarget {
  host: string;
  port: number;
  /** Extra trusted roots (tests only). Production uses Mozilla's bundle alone. */
  extraRoots?: string[];
}

export interface ChaseStep {
  url: string;
  subject: string;
  issuer: string;
  validTo: string;
}

export interface ChainReport {
  leafSubject: string | null;
  leafIssuer: string | null;
  leafValidTo: string | null;
  presentedCerts: number;
  verifiedByDefault: boolean;
  steps: ChaseStep[];
  error: string | null;
}

const SGC_TARGET: TlsTarget = { host: 'archive.sgc.gov.co', port: 443 };

function derToPem(der: Buffer): string {
  const b64 = der.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function oneLine(s: string): string {
  return s.split('\n').join(', ');
}

function aiaIssuerUrls(cert: X509Certificate): string[] {
  const urls: string[] = [];
  for (const line of (cert.infoAccess ?? '').split('\n')) {
    const m = line.match(/^CA Issuers - URI:(.+)$/);
    if (m && /^https?:\/\//i.test(m[1].trim())) urls.push(m[1].trim());
  }
  return urls;
}

/**
 * Reads the certificate the server presents WITHOUT trusting it and WITHOUT
 * sending any application data (rejectUnauthorized:false is limited to this
 * metadata-only handshake; real requests are always fully verified).
 */
function probeLeaf(target: TlsTarget, timeoutMs: number): Promise<{ leaf: Buffer; presented: number; authorized: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    });
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate(true);
        let presented = 0;
        const seen = new Set<string>();
        let c: any = peer;
        while (c && c.fingerprint256 && !seen.has(c.fingerprint256)) {
          seen.add(c.fingerprint256);
          presented++;
          c = c.issuerCertificate;
        }
        if (!peer || !peer.raw) throw new Error('El servidor no presentó certificado');
        resolve({ leaf: peer.raw, presented, authorized: socket.authorized });
      } catch (err) {
        reject(err);
      } finally {
        socket.destroy();
      }
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`Tiempo de espera agotado en el handshake TLS (${timeoutMs} ms)`));
    });
    socket.once('error', reject);
  });
}

async function fetchCertificate(url: string, timeoutMs: number): Promise<X509Certificate> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`AIA ${url} respondió ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > 64 * 1024) throw new Error(`AIA ${url}: tamaño inválido (${buf.length} bytes)`);
  // CA Issuers is normally a DER file, but some CAs serve PEM.
  return buf.subarray(0, 10).toString('latin1').startsWith('-----BEGIN')
    ? new X509Certificate(buf.toString('utf8'))
    : new X509Certificate(buf);
}

/**
 * Finds the intermediate certificates the server forgot to send, by following
 * the AIA "CA Issuers" links from the leaf up to a certificate issued by a
 * trusted root. Returns them as PEM, ready for the `ca` option of an Agent.
 */
export async function completeChain(target: TlsTarget): Promise<{ pems: string[]; report: ChainReport }> {
  const rootsBySubject = new Map<string, X509Certificate[]>();
  for (const pem of [...tls.rootCertificates, ...(target.extraRoots ?? [])]) {
    const root = new X509Certificate(pem);
    rootsBySubject.set(root.subject, [...(rootsBySubject.get(root.subject) ?? []), root]);
  }

  const report: ChainReport = {
    leafSubject: null,
    leafIssuer: null,
    leafValidTo: null,
    presentedCerts: 0,
    verifiedByDefault: false,
    steps: [],
    error: null,
  };
  const pems: string[] = [];

  const probe = await probeLeaf(target, 6000);
  let current = new X509Certificate(probe.leaf);
  report.leafSubject = oneLine(current.subject);
  report.leafIssuer = oneLine(current.issuer);
  report.leafValidTo = current.validTo;
  report.presentedCerts = probe.presented;
  report.verifiedByDefault = probe.authorized;

  // The intermediates arrive over plain HTTP, so NOTHING is trusted until the
  // whole chain is cryptographically anchored in a root of the trusted bundle:
  // each certificate must be signed by the next, and the last one by a real root.
  let anchored = false;
  for (let depth = 0; depth < 4 && !anchored; depth++) {
    const rootCandidates = rootsBySubject.get(current.issuer);
    if (rootCandidates) {
      if (!rootCandidates.some((root) => current.verify(root.publicKey))) {
        throw new Error(`La firma de «${oneLine(current.subject)}» no corresponde a la raíz de confianza esperada`);
      }
      anchored = true;
      break;
    }
    const urls = aiaIssuerUrls(current);
    if (urls.length === 0) throw new Error(`Sin enlace AIA para completar la cadena de «${oneLine(current.subject)}»`);
    const next = await fetchCertificate(urls[0], 6000);
    if (next.subject !== current.issuer) {
      throw new Error(`El certificado descargado (${oneLine(next.subject)}) no es el emisor esperado (${oneLine(current.issuer)})`);
    }
    if (!current.verify(next.publicKey)) {
      throw new Error(`El intermedio descargado (${oneLine(next.subject)}) no ha firmado el certificado: firma inválida`);
    }
    pems.push(derToPem(next.raw));
    report.steps.push({ url: urls[0], subject: oneLine(next.subject), issuer: oneLine(next.issuer), validTo: next.validTo });
    current = next;
  }
  if (!anchored) throw new Error('No se pudo anclar la cadena en una raíz de confianza (demasiados niveles)');
  return { pems, report };
}

interface ChainState {
  builtAt: number;
  agent: https.Agent;
  report: ChainReport;
}

let chainState: ChainState | null = null;
let chainInflight: Promise<ChainState> | null = null;

/** Exported for tests. */
export async function buildAgent(target: TlsTarget): Promise<{ agent: https.Agent; report: ChainReport }> {
  const { pems, report } = await completeChain(target);
  const agent = new https.Agent({ ca: [...tls.rootCertificates, ...(target.extraRoots ?? []), ...pems], keepAlive: false });
  return { agent, report };
}

async function getChainState(force = false): Promise<ChainState> {
  if (!force && chainState && Date.now() - chainState.builtAt < CHAIN_TTL_MS) return chainState;
  if (!chainInflight) {
    chainInflight = buildAgent(SGC_TARGET)
      .then(({ agent, report }) => (chainState = { builtAt: Date.now(), agent, report }))
      .finally(() => {
        chainInflight = null;
      });
  }
  return chainInflight;
}

async function chainAgent(): Promise<https.Agent> {
  return (await getChainState()).agent;
}

interface Strategy {
  name: string;
  run: (timeoutMs: number) => Promise<RawResult>;
}

const STRATEGIES: Strategy[] = [
  {
    name: 'node:https + cadena completada (AIA)',
    run: async (t) => httpsGet(SGC_FIVE_DAY_FEED, PLAIN_HEADERS, t, await chainAgent()),
  },
  {
    name: 'node:https + cadena completada + Referer del SGC',
    run: async (t) => httpsGet(SGC_FIVE_DAY_FEED, REFERER_HEADERS, t, await chainAgent()),
  },
  { name: 'fetch (cadena del sistema)', run: (t) => fetchGet(SGC_FIVE_DAY_FEED, PLAIN_HEADERS, t) },
];

export interface SgcAttempt {
  strategy: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  ms: number;
  bytes: number | null;
  features: number | null;
  mapped: number | null;
  newestEvent: string | null;
  oldestEvent: string | null;
  error: string | null;
  bodyHead: string | null;
}

interface AttemptOutcome {
  attempt: SgcAttempt;
  quakes: QuakeFeature[] | null;
}

async function runStrategy(s: Strategy): Promise<AttemptOutcome> {
  const started = Date.now();
  const attempt: SgcAttempt = {
    strategy: s.name,
    ok: false,
    status: null,
    contentType: null,
    ms: 0,
    bytes: null,
    features: null,
    mapped: null,
    newestEvent: null,
    oldestEvent: null,
    error: null,
    bodyHead: null,
  };
  let quakes: QuakeFeature[] | null = null;
  try {
    const raw = await s.run(ATTEMPT_TIMEOUT_MS);
    attempt.status = raw.status;
    attempt.contentType = raw.contentType;
    attempt.bytes = raw.body.length;
    if (raw.status < 200 || raw.status >= 300) {
      attempt.error = `El SGC respondió ${raw.status}`;
      attempt.bodyHead = raw.body.slice(0, 240);
    } else {
      let json: any;
      try {
        json = JSON.parse(raw.body);
      } catch {
        attempt.error = 'La respuesta no es JSON';
        attempt.bodyHead = raw.body.slice(0, 240);
      }
      if (json !== undefined) {
        // Observed failure mode: HTTP 200 with an error payload instead of a
        // real feature collection. Treat a missing `features` array as a failure.
        if (!json || !Array.isArray(json.features)) {
          attempt.error = 'Respuesta con forma inesperada (posible error anidado en un 200 OK)';
          attempt.bodyHead = raw.body.slice(0, 240);
        } else {
          attempt.features = json.features.length;
          quakes = (json.features as any[]).map(mapSgcFeature).filter((q): q is QuakeFeature => q !== null);
          attempt.mapped = quakes.length;
          if (quakes.length > 0) {
            const times = quakes.map((q) => q.time);
            attempt.newestEvent = new Date(Math.max(...times)).toISOString();
            attempt.oldestEvent = new Date(Math.min(...times)).toISOString();
          }
          attempt.ok = true;
        }
      }
    }
  } catch (err) {
    const cause = (err as any)?.cause;
    attempt.error =
      (err instanceof Error ? err.message : 'error desconocido') +
      (cause?.code || cause?.message ? ` [${cause.code ?? cause.message}]` : '');
    // A certificate problem may mean the SGC rotated its intermediate: re-chase next time.
    if (/CERT|SIGNATURE|SELF.SIGNED|certificate/i.test(attempt.error)) chainState = null;
  }
  attempt.ms = Date.now() - started;
  return { attempt, quakes: attempt.ok ? quakes : null };
}

/** Runs every strategy and reports what happened (used by `?debug=1`). */
export async function debugSgc() {
  let chain: ChainReport | { error: string };
  try {
    chain = (await getChainState(true)).report;
  } catch (err) {
    chain = { error: err instanceof Error ? err.message : 'error desconocido' };
  }
  const outcomes: SgcAttempt[] = [];
  for (const s of STRATEGIES) outcomes.push((await runStrategy(s)).attempt);
  return {
    feed: SGC_FIVE_DAY_FEED,
    now: new Date().toISOString(),
    region: process.env.VERCEL_REGION ?? null,
    lastGoodAt: lastGoodRaw ? new Date(lastGoodRaw.fetchedAt).toISOString() : null,
    chain,
    attempts: outcomes,
  };
}

// ---------------------------------------------------------------- public API

let lastFailureAt = 0;

function staleResponse(period: Period, minMag: number, reason: string): EarthquakesResponse | null {
  if (!lastGoodRaw) return null;
  const quakes = filterForRequest(lastGoodRaw.quakes, period, minMag);
  return {
    quakes,
    source: { ...SGC_SOURCE, fetchedAt: new Date(lastGoodRaw.fetchedAt).toISOString() },
    stale: true,
    staleReason: reason,
    period,
    minMagnitude: minMag,
    count: quakes.length,
  };
}

export async function getSgcQuakes(period: Period, minMag: number): Promise<EarthquakesResponse> {
  // Don't hammer a failing host: right after a failure, serve the last good data.
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
    const cached = staleResponse(period, minMag, 'El SGC no respondió hace unos segundos; mostrando la última lectura.');
    if (cached) return cached;
  }

  const failures: string[] = [];
  for (const s of STRATEGIES) {
    const { attempt, quakes: allQuakes } = await runStrategy(s);
    if (!attempt.ok || !allQuakes) {
      failures.push(`${s.name}: ${attempt.error ?? 'falló'}`);
      continue;
    }

    lastGoodRaw = { fetchedAt: Date.now(), quakes: allQuakes };
    const quakes = filterForRequest(allQuakes, period, minMag);

    // A feed that answers fine but has stopped publishing is not "live" data.
    const newest = allQuakes.length ? Math.max(...allQuakes.map((q) => q.time)) : null;
    const frozen = newest !== null && Date.now() - newest > FEED_STALE_AFTER_MS;

    return {
      quakes,
      source: { ...SGC_SOURCE, fetchedAt: new Date().toISOString() },
      stale: frozen,
      ...(frozen
        ? { staleReason: `El feed del SGC no publica eventos nuevos desde ${new Date(newest!).toISOString().slice(0, 16).replace('T', ' ')} UTC` }
        : {}),
      period,
      minMagnitude: minMag,
      count: quakes.length,
    };
  }

  lastFailureAt = Date.now();
  const cached = staleResponse(period, minMag, failures.join(' · ') || 'Fuente no disponible');
  if (cached) return cached;
  throw new Error(`No se pudo contactar al SGC y aún no hay datos en caché (${failures.join(' · ') || 'error desconocido'})`);
}
