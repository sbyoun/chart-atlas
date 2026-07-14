import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const isProduction = process.env.NODE_ENV === 'production';
const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH || '/');
const spotifyConfigPath =
  process.env.SPOTIFY_CONFIG_PATH || '/home/ubuntu/spotify-mcp-server/spotify-config.json';
const codexBin = process.env.CODEX_BIN || '/home/ubuntu/.npm-global/bin/codex';
const codexExtraArgs = (process.env.CODEX_EXTRA_ARGS || '')
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const playlistSessionStorePath =
  process.env.PLAYLIST_SESSIONS_PATH || path.join(dataDir, 'playlist-chat-sessions.json');
const weeklyEditorialNotesPath = path.join(__dirname, 'content', 'weekly-editorial-notes.json');
const playlistRepoUrl = 'https://github.com/sbyoun/spotify-mcp-server';
const publicPlaylistWritesEnabled = process.env.CHART_ATLAS_PUBLIC_PLAYLIST_WRITES === 'true';
const accessLoggingEnabled = process.env.CHART_ATLAS_ACCESS_LOG !== 'false';
const clientAuditEventsEnabled = process.env.CHART_ATLAS_CLIENT_AUDIT_EVENTS !== 'false';
let activePlaylistTask = false;
let activePlaylistSessionId = '';
let cachedSpotifyUserId = '';
let cachedSpotifyClientCredentials = { accessToken: '', expiresAt: 0 };
let playlistCache = { data: null, expiresAt: 0 };
// Spotify can report tracks.total = 0 for a few minutes right after playlist
// creation; remember what we just inserted so the studio list stays truthful.
const recentPlaylistTrackCounts = new Map();
const RECENT_PLAYLIST_TRACK_COUNT_TTL = 10 * 60_000;
// Only playlists created by Chart Atlas features belong in the public studio
// list; the account also holds unrelated personal playlists.
const CHART_ATLAS_PLAYLIST_PREFIXES = ['Chart Atlas', 'Genre Atlas'];
let crawlerSummaryCache = { key: '', html: '' };
const artistMetadataCache = new Map();
const externalArtistMetadataCache = new Map();
const trackMetadataCache = new Map();
const trackArtistGenreCache = new Map();
const risingArtistProfileCache = new Map();
const tasteTrackProfileCache = new Map();
const PLAYLIST_CACHE_TTL = 60_000;
const RISING_ARTIST_PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000;
const TASTE_TRACK_PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000;
const TASTE_UNAVAILABLE_PROFILE_CACHE_TTL = 6 * 60 * 60 * 1000;
const ITUNES_TASTE_PREVIEW_MATCH_THRESHOLD = 18;
const MIN_INDEXABLE_GENRE_TRACKS = 3;
const EXTERNAL_ARTIST_LOOKUP_LIMIT = readPositiveIntegerEnv('EXTERNAL_ARTIST_LOOKUP_LIMIT', 220);
const TRACK_METADATA_LOOKUP_LIMIT = readPositiveIntegerEnv('TRACK_METADATA_LOOKUP_LIMIT', 140);
const EXTERNAL_METADATA_USER_AGENT =
  process.env.EXTERNAL_METADATA_USER_AGENT || 'ChartAtlas/0.1 (local genre discovery)';
const SPA_FALLBACK_PATHS = new Set([
  '/',
]);

const playlistRelayInstruction = `
You are a dedicated Spotify playlist agent for a web chat panel.

Hard constraints:
- Only help with Spotify playlist work.
- Stay within playlist discovery, curation, naming, descriptions, sequencing, visibility, and Spotify playlist creation or editing flows.
- Prefer Spotify MCP-oriented actions and guidance.
- Do not do coding work, file edits, git operations, shell tasks, or unrelated research.
- If the user asks for anything outside Spotify playlist work, refuse briefly and redirect them back to playlist tasks.
- Do not provide engineering guidance, server administration help, deployment help, or debugging help.
- Do not mention internal tools, Codex internals, shell commands, repo operations, or implementation details unless the user is explicitly asking about playlist-agent behavior itself.
- If a request is ambiguous, interpret it in the narrowest Spotify-playlist-safe way.
- Keep responses concise and user-facing.
`.trim();

const playlistBlockedPatterns = [
  /\bgit\b/i,
  /\bgithub\b/i,
  /\bcommit\b/i,
  /\bmerge\b/i,
  /\bpull request\b/i,
  /\bcode\b/i,
  /\bcoding\b/i,
  /\bprogram\b/i,
  /\bscript\b/i,
  /\bserver\b/i,
  /\bdeploy\b/i,
  /\bterminal\b/i,
  /\bbash\b/i,
  /\bshell\b/i,
  /\bnpm\b/i,
  /\bpython\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bedit file\b/i,
  /\bmodify file\b/i,
];

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};

function normalizeBasePath(value) {
  const normalized = `/${String(value || '').replace(/^\/+|\/+$/g, '')}`;
  return normalized === '/' ? '' : normalized;
}

function readPositiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripAppBase(requestPath) {
  if (!appBasePath) {
    return requestPath;
  }

  if (requestPath === appBasePath) {
    return '/';
  }

  if (requestPath.startsWith(`${appBasePath}/`)) {
    return requestPath.slice(appBasePath.length) || '/';
  }

  return requestPath;
}

function readCliValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function loadSpotifyConfig() {
  const raw = fs.readFileSync(spotifyConfigPath, 'utf8');
  return JSON.parse(raw);
}

function saveSpotifyConfig(config) {
  fs.writeFileSync(spotifyConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function refreshSpotifyAccessToken(config) {
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString(
    'base64',
  );

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify token refresh failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  config.accessToken = payload.access_token;
  config.expiresAt = Date.now() + (payload.expires_in || 3600) * 1000;
  if (payload.refresh_token) {
    config.refreshToken = payload.refresh_token;
  }
  saveSpotifyConfig(config);
  return config.accessToken;
}

async function getSpotifyAccessToken() {
  const config = loadSpotifyConfig();
  if (!config.accessToken || !config.refreshToken) {
    throw new Error('Spotify user token is missing. Run manual Spotify auth first.');
  }

  if (!config.expiresAt || config.expiresAt <= Date.now()) {
    return refreshSpotifyAccessToken(config);
  }

  return config.accessToken;
}

async function getSpotifyClientCredentialsAccessToken() {
  if (
    cachedSpotifyClientCredentials.accessToken &&
    cachedSpotifyClientCredentials.expiresAt > Date.now()
  ) {
    return cachedSpotifyClientCredentials.accessToken;
  }

  const config = loadSpotifyConfig();
  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString(
    'base64',
  );

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Spotify client credentials failed: ${response.status} ${text}`);
  }

  const payload = await response.json();
  cachedSpotifyClientCredentials = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max((payload.expires_in || 3600) - 60, 60) * 1000,
  };

  return cachedSpotifyClientCredentials.accessToken;
}

async function spotifyRequest(pathname, options = {}) {
  const accessToken = await getSpotifyAccessToken();
  const response = await fetch(`https://api.spotify.com/v1${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Spotify API ${response.status} ${pathname}: ${text}`);
    error.statusCode = response.status;
    error.responseBody = text;
    error.spotifyPath = pathname;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function spotifyPublicRequest(pathname) {
  const accessToken = await getSpotifyClientCredentialsAccessToken();
  const response = await fetch(`https://api.spotify.com/v1${pathname}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const error = new Error(`Spotify public API ${response.status} ${pathname}: ${text}`);
    error.statusCode = response.status;
    error.responseBody = text;
    error.spotifyPath = pathname;
    throw error;
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function getSpotifyUserId() {
  if (cachedSpotifyUserId) {
    return cachedSpotifyUserId;
  }

  const me = await spotifyRequest('/me');
  cachedSpotifyUserId = me.id;
  return cachedSpotifyUserId;
}

function isChartAtlasPlaylistName(name) {
  const normalized = String(name || '').trim();
  return CHART_ATLAS_PLAYLIST_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function rememberPlaylistTrackCount(playlistId, count) {
  recentPlaylistTrackCounts.set(playlistId, {
    count,
    expiresAt: Date.now() + RECENT_PLAYLIST_TRACK_COUNT_TTL,
  });
}

function resolvePlaylistTracksTotal(playlist) {
  const reported = playlist.items?.total || playlist.tracks?.total || 0;
  if (reported > 0) {
    return reported;
  }

  const recent = recentPlaylistTrackCounts.get(playlist.id);
  return recent && recent.expiresAt > Date.now() ? recent.count : reported;
}

async function fetchMyPublicPlaylists(force = false) {
  if (!force && playlistCache.data && Date.now() < playlistCache.expiresAt) {
    return playlistCache.data;
  }

  const [userId, firstPage] = await Promise.all([
    getSpotifyUserId(),
    spotifyRequest('/me/playlists?limit=50'),
  ]);
  const all = [...(firstPage.items || [])];
  let nextPath = firstPage.next
    ? firstPage.next.replace('https://api.spotify.com/v1', '')
    : null;

  while (nextPath) {
    const payload = await spotifyRequest(nextPath);
    all.push(...(payload.items || []));
    nextPath = payload.next ? payload.next.replace('https://api.spotify.com/v1', '') : null;
  }

  const playlists = all
    .filter(
      (playlist) =>
        playlist?.owner?.id === userId &&
        playlist.public === true &&
        isChartAtlasPlaylistName(playlist.name),
    )
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description || '',
      tracksTotal: resolvePlaylistTracksTotal(playlist),
      imageUrl: playlist.images?.[0]?.url || null,
      openUrl:
        playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`,
      embedUrl: `https://open.spotify.com/embed/playlist/${playlist.id}?utm_source=generator`,
    }));

  playlistCache = { data: playlists, expiresAt: Date.now() + PLAYLIST_CACHE_TTL };
  return playlists;
}

function ensurePlaylistSessionStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(playlistSessionStorePath)) {
    fs.writeFileSync(
      playlistSessionStorePath,
      `${JSON.stringify({ currentSessionId: '', sessions: [] }, null, 2)}\n`,
      'utf8',
    );
  }
}

function loadPlaylistSessionStore() {
  ensurePlaylistSessionStore();
  return JSON.parse(fs.readFileSync(playlistSessionStorePath, 'utf8'));
}

function savePlaylistSessionStore(store) {
  ensurePlaylistSessionStore();
  fs.writeFileSync(playlistSessionStorePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function resetPlaylistSessionStore() {
  const store = { currentSessionId: '', sessions: [] };
  savePlaylistSessionStore(store);
  activePlaylistSessionId = '';
  return store;
}

function listPlaylistSessionsForApi(store) {
  return (store.sessions || []).map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }));
}

function buildCodexResumeCommand(threadId, message) {
  return [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    ...codexExtraArgs,
    threadId,
    message,
  ];
}

function buildCodexCreateCommand(message) {
  return ['exec', '--json', '--skip-git-repo-check', ...codexExtraArgs, message];
}

function buildPlaylistRelayPrompt(message) {
  return `${playlistRelayInstruction}\n\nUser request:\n${message}`;
}

function shouldBlockPlaylistMessage(message) {
  return playlistBlockedPatterns.some((pattern) => pattern.test(message));
}

function runCodex(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const assistantMessages = [];
    let stderr = '';
    let stdoutBuffer = '';
    let threadId = '';

    function consumeLine(line) {
      if (!line.startsWith('{')) return;

      try {
        const payload = JSON.parse(line);
        if (payload.type === 'thread.started' && payload.thread_id) {
          threadId = payload.thread_id;
          return;
        }

        if (payload.type !== 'item.completed') return;
        const item = payload.item || {};
        if (item.type !== 'agent_message') return;
        const text = (item.text || '').trim();
        if (text) assistantMessages.push(text);
      } catch (_error) {
        // Ignore non-JSON or partial lines from the CLI stream.
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      lines.forEach(consumeLine);
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer.trim());

      const reply =
        assistantMessages.length > 0
          ? assistantMessages.slice(-1)[0]
          : stderr.trim() || 'Codex 응답을 파싱하지 못했습니다.';

      if (code && assistantMessages.length === 0) {
        reject(new Error(reply));
        return;
      }

      resolve({
        threadId,
        reply,
        exitCode: code ?? 0,
      });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function normalizeTrackUris(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((item) => String(item || '').trim())
        .map((item) => {
          const openUrlMatch = item.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
          if (openUrlMatch) return `spotify:track:${openUrlMatch[1]}`;

          const rawIdMatch = item.match(/^[A-Za-z0-9]{22}$/);
          if (rawIdMatch) return `spotify:track:${item}`;

          return item;
        })
        .filter((item) => /^spotify:track:[A-Za-z0-9]{22}$/.test(item)),
    ),
  ];
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function searchTokens(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function scoreSpotifyTrackMatch(item, seed) {
  const itemTrack = normalizeSearchText(item.name);
  const wantedTrack = normalizeSearchText(seed.track);
  const itemArtists = normalizeSearchText((item.artists || []).map((artist) => artist.name).join(' '));
  const wantedArtist = normalizeSearchText(seed.artist);
  let score = 0;

  if (itemTrack === wantedTrack) score += 12;
  if (itemTrack.includes(wantedTrack) || wantedTrack.includes(itemTrack)) score += 6;
  for (const token of searchTokens(seed.track)) {
    if (itemTrack.includes(token)) score += 1.5;
  }

  if (itemArtists.includes(wantedArtist) || wantedArtist.includes(itemArtists)) score += 8;
  for (const token of searchTokens(seed.artist)) {
    if (itemArtists.includes(token)) score += 2;
  }

  score += Math.min((item.popularity || 0) / 100, 1.5);
  return score;
}

function normalizeGenreSeeds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const seeds = [];

  for (const seed of value) {
    const artist = String(seed?.artist || '').trim();
    const track = String(seed?.track || '').trim();
    if (!artist || !track) continue;

    const key = `${normalizeSearchText(artist)}::${normalizeSearchText(track)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ artist, track });
  }

  return seeds.slice(0, 80);
}

function normalizeSpotifyIds(value, limit = 500) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .map((item) => String(item || '').trim())
        .filter((item) => /^[A-Za-z0-9]{22}$/.test(item)),
    ),
  ].slice(0, limit);
}

function normalizeExternalArtists(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const artists = [];

  for (const item of value) {
    const id = String(item?.id || '').trim();
    const name = String(item?.name || '').trim();
    if (!id || !name) continue;

    const key = id || normalizeSearchText(name);
    if (seen.has(key)) continue;
    seen.add(key);
    artists.push({ id, name });
  }

  return artists.slice(0, EXTERNAL_ARTIST_LOOKUP_LIMIT);
}

function normalizeExternalTracks(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const tracks = [];

  for (const item of value) {
    const id = String(item?.id || '').trim();
    const title = String(item?.title || '').trim();
    const artist = String(item?.artist || '').trim();
    if (!id || !title || !artist) continue;

    const countryCodes = Array.isArray(item?.countryCodes)
      ? item.countryCodes
          .map((code) => String(code || '').trim().toLowerCase())
          .filter((code) => /^[a-z]{2}$/.test(code))
      : [];
    const key = id || `${normalizeSearchText(title)}::${normalizeSearchText(artist)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({
      id,
      title,
      artist,
      countryCodes: [...new Set(countryCodes)].slice(0, 6),
    });
  }

  return tracks.slice(0, TRACK_METADATA_LOOKUP_LIMIT);
}

function normalizeRisingArtistSeeds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const artists = [];

  for (const item of value) {
    const id = String(item?.id || '').trim();
    const name = String(item?.name || '').trim();
    if (!id || !name) continue;

    const key = id || normalizeSearchText(name);
    if (seen.has(key)) continue;
    seen.add(key);
    artists.push({ id, name });
  }

  return artists.slice(0, 30);
}

function externalCacheKey(name) {
  return normalizeSearchText(name);
}

function trackCacheKey(track) {
  return `${track.id}::${normalizeSearchText(track.title)}::${normalizeSearchText(track.artist)}`;
}

function trackArtistGenreCacheKey(artist, countryCode = '') {
  return `${normalizeSearchText(artist)}::${String(countryCode || '').toLowerCase()}`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const text = String(value || '').trim();
    const key = normalizeSearchText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }

  return result;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function artistProfileSlug(name) {
  return normalizeSearchText(name)
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function preferredLanguageValue(values = {}) {
  for (const language of ['en', 'pt', 'es', 'fr', 'de', 'id', 'th', 'ja', 'ko', 'ar']) {
    if (values[language]?.value) {
      return values[language].value;
    }
  }

  return Object.values(values)[0]?.value || '';
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8000);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': EXTERNAL_METADATA_USER_AGENT,
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 8000);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': EXTERNAL_METADATA_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function tokenHitScore(wanted, candidate, tokenWeight = 1) {
  return searchTokens(wanted).reduce((sum, token) => (
    candidate.includes(token) ? sum + tokenWeight : sum
  ), 0);
}

function scoreItunesSongMatch(item, track) {
  const itemTrack = normalizeSearchText(item.trackName);
  const wantedTrack = normalizeSearchText(track.title);
  const itemArtist = normalizeSearchText(item.artistName);
  const wantedArtist = normalizeSearchText(track.artist);
  let score = 0;

  if (itemArtist === wantedArtist) score += 14;
  else if (itemArtist.includes(wantedArtist) || wantedArtist.includes(itemArtist)) score += 7;
  score += tokenHitScore(track.artist, itemArtist, 1.5);

  if (itemTrack === wantedTrack) score += 14;
  else if (itemTrack.includes(wantedTrack) || wantedTrack.includes(itemTrack)) score += 8;
  score += tokenHitScore(track.title, itemTrack, 1.25);

  return score;
}

function tokenCoverage(wanted, candidate) {
  const tokens = searchTokens(wanted);
  if (tokens.length === 0) {
    return 0;
  }

  const hits = tokens.filter((token) => candidate.includes(token)).length;
  return hits / tokens.length;
}

function isItunesTasteArtistCompatible(item, track) {
  const itemArtist = normalizeSearchText(item.artistName);
  const wantedArtist = normalizeSearchText(track.artist);
  if (!itemArtist || !wantedArtist) {
    return false;
  }

  if (itemArtist === wantedArtist) {
    return true;
  }

  const wantedTokens = searchTokens(track.artist);
  const isShortSingleName = wantedTokens.length === 1 && wantedTokens[0].length <= 3;
  if (isShortSingleName) {
    return false;
  }

  return (
    itemArtist.includes(wantedArtist) ||
    wantedArtist.includes(itemArtist) ||
    tokenCoverage(track.artist, itemArtist) >= 0.6
  );
}

function isItunesTasteTrackCompatible(item, track) {
  const itemTrack = normalizeSearchText(item.trackName);
  const wantedTrack = normalizeSearchText(track.title);
  if (!itemTrack || !wantedTrack) {
    return false;
  }

  return (
    itemTrack === wantedTrack ||
    itemTrack.includes(wantedTrack) ||
    wantedTrack.includes(itemTrack) ||
    tokenCoverage(track.title, itemTrack) >= 0.55
  );
}

async function searchItunesTrackGenre(track, countryCode) {
  const params = new URLSearchParams({
    term: `${track.artist} ${track.title}`,
    media: 'music',
    entity: 'song',
    country: countryCode,
    limit: '8',
  });
  const payload = await fetchJson(`https://itunes.apple.com/search?${params.toString()}`, {
    timeoutMs: 7000,
  });
  const candidates = Array.isArray(payload?.results) ? payload.results : [];
  let best = null;
  let bestScore = -Infinity;

  for (const item of candidates) {
    const score = scoreItunesSongMatch(item, track);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }

  if (!best || bestScore < 12 || !best.primaryGenreName) {
    return null;
  }

  return {
    title: best.trackName || track.title,
    artist: best.artistName || track.artist,
    genres: uniqueStrings([best.primaryGenreName]),
    tags: uniqueStrings([best.primaryGenreName]),
    descriptions: uniqueStrings([
      best.collectionName ? `Apple/iTunes collection: ${best.collectionName}` : '',
    ]),
    sources: ['Apple/iTunes'],
    links: best.trackViewUrl ? [{ source: 'Apple/iTunes', url: best.trackViewUrl }] : [],
    countryCode,
    matchScore: Number(bestScore.toFixed(2)),
  };
}

async function searchItunesArtistDominantGenre(track, countryCode) {
  const params = new URLSearchParams({
    term: track.artist,
    media: 'music',
    entity: 'song',
    country: countryCode,
    limit: '12',
  });
  const payload = await fetchJson(`https://itunes.apple.com/search?${params.toString()}`, {
    timeoutMs: 7000,
  });
  const wantedArtist = normalizeSearchText(track.artist);
  const matches = (Array.isArray(payload?.results) ? payload.results : []).filter((item) => {
    const itemArtist = normalizeSearchText(item.artistName);
    return itemArtist === wantedArtist && item.primaryGenreName;
  });

  if (matches.length === 0) {
    return null;
  }

  const genreCounts = new Map();
  for (const item of matches) {
    const genre = String(item.primaryGenreName || '').trim();
    if (!genre) continue;
    genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
  }
  const [genre, count] = [...genreCounts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (!genre) {
    return null;
  }

  return {
    title: track.title,
    artist: track.artist,
    genres: uniqueStrings([genre]),
    tags: uniqueStrings([genre]),
    descriptions: uniqueStrings([
      `Apple/iTunes artist fallback: ${count}/${matches.length} matched songs use ${genre}`,
    ]),
    sources: ['Apple/iTunes'],
    links: [],
    countryCode,
    matchScore: Number((10 + count).toFixed(2)),
  };
}

async function lookupExternalTrackMetadata(track) {
  const cacheKey = trackCacheKey(track);
  if (trackMetadataCache.has(cacheKey)) {
    return trackMetadataCache.get(cacheKey);
  }

  const candidateCountries = [
    ...track.countryCodes,
    'us',
    'gb',
    'de',
    'se',
    'sa',
    'eg',
    'jp',
    'kr',
  ];
  const countries = [...new Set(candidateCountries)].slice(0, 8);
  let metadata = null;

  for (const countryCode of countries) {
    try {
      metadata = await searchItunesTrackGenre(track, countryCode);
      if (!metadata) {
        metadata = await searchItunesArtistDominantGenre(track, countryCode);
      }
    } catch (error) {
      if (error?.status === 429) {
        break;
      }
      metadata = null;
    }
    if (metadata) {
      if (metadata.genres?.length > 0) {
        trackArtistGenreCache.set(trackArtistGenreCacheKey(track.artist, countryCode), {
          genres: metadata.genres,
          tags: metadata.tags,
          countryCode,
        });
        trackArtistGenreCache.set(trackArtistGenreCacheKey(track.artist), {
          genres: metadata.genres,
          tags: metadata.tags,
          countryCode,
        });
      }
      break;
    }
  }

  if (!metadata) {
    for (const countryCode of ['', ...countries]) {
      const cached = trackArtistGenreCache.get(trackArtistGenreCacheKey(track.artist, countryCode));
      if (!cached?.genres?.length) continue;
      metadata = {
        title: track.title,
        artist: track.artist,
        genres: cached.genres,
        tags: cached.tags || cached.genres,
        descriptions: ['Apple/iTunes current-chart artist genre propagation'],
        sources: ['Apple/iTunes'],
        links: [],
        countryCode: cached.countryCode || countryCode,
        matchScore: 9,
      };
      break;
    }
  }

  const normalized = metadata || {
    title: track.title,
    artist: track.artist,
    genres: [],
    tags: [],
    descriptions: [],
    sources: [],
    links: [],
    countryCode: '',
    matchScore: 0,
  };

  trackMetadataCache.set(cacheKey, normalized);
  return normalized;
}

async function fetchViberateArtistMetadata(name) {
  const slug = artistProfileSlug(name);
  if (!slug) {
    return null;
  }

  const url = `https://www.viberate.com/artist/${slug}/`;
  const html = await fetchText(url, { timeoutMs: 9000 });
  const compactHtml = html.replace(/\s+/g, ' ');
  const jsonGenre = compactHtml.match(/"genre"\s*:\s*"([^"]+)"/)?.[1] || '';
  const titleGenre = compactHtml.match(/class="genres" title="([^"]+)"/)?.[1] || '';
  const genreSpanHtml = compactHtml.match(/<span class="genres"[^>]*>([\s\S]*?)<\/span>/)?.[1] || '';
  const genreSpanText = genreSpanHtml
    .replace(/<!--.*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  const visibleGenres = [...compactHtml.matchAll(/<span[^>]*>([^<]*(?:Schlager|Sertanejo|Khaleeji|Khaliji|Arabic Pop|Mahraganat|Afrobeats|K-pop|Trot|Dangdut|Manele|Chalga|Disco Polo)[^<]*)<\/span>/gi)]
    .map((match) => match[1]);
  const description = compactHtml
    .match(/<meta name="description" content="([^"]+)"/)?.[1] || '';
  const genres = uniqueStrings(
    [jsonGenre, titleGenre, genreSpanText, ...visibleGenres]
      .flatMap((value) => decodeHtmlEntities(value).split(/\s*,\s*/))
      .map((value) => value.trim())
      .filter(Boolean),
  );

  if (genres.length === 0) {
    return null;
  }

  return {
    tags: genres,
    genres,
    descriptions: uniqueStrings([
      `Viberate artist profile genres: ${genres.join(', ')}`,
      decodeHtmlEntities(description),
    ]),
    source: 'Viberate',
    url,
  };
}

async function searchMusicBrainzArtist(name) {
  const params = new URLSearchParams({
    query: `artist:"${name}"`,
    fmt: 'json',
    limit: '3',
  });
  const payload = await fetchJson(`https://musicbrainz.org/ws/2/artist/?${params.toString()}`, {
    timeoutMs: 9000,
  });
  const candidates = payload?.artists || [];
  const best =
    candidates.find((artist) => Number(artist.score || 0) >= 95) ||
    candidates.find((artist) => Number(artist.score || 0) >= 80) ||
    null;

  if (!best) {
    return null;
  }

  return {
    id: best.id,
    name: best.name || '',
    country: best.country || '',
    tags: uniqueStrings([
      ...(best.genres || []).map((tag) => tag.name),
      ...(best.tags || []).map((tag) => tag.name),
    ]),
    description: [best.disambiguation, best.type, best.country].filter(Boolean).join(' · '),
    url: best.id ? `https://musicbrainz.org/artist/${best.id}` : '',
  };
}

async function searchWikidataArtist(name) {
  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: name,
    language: 'en',
    format: 'json',
    limit: '3',
  });
  const payload = await fetchJson(`https://www.wikidata.org/w/api.php?${params.toString()}`, {
    timeoutMs: 9000,
  });
  const candidates = payload?.search || [];
  const normalizedName = normalizeSearchText(name);
  const best =
    candidates.find((item) => normalizeSearchText(item.label || '') === normalizedName) ||
    candidates[0] ||
    null;

  if (!best?.id) {
    return null;
  }

  return {
    id: best.id,
    label: best.label || '',
    description: best.description || '',
    url: best.concepturi || `https://www.wikidata.org/wiki/${best.id}`,
  };
}

async function fetchWikidataEntities(ids) {
  if (ids.length === 0) {
    return new Map();
  }

  const entities = new Map();

  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: chunk.join('|'),
      props: 'claims|labels|descriptions|sitelinks',
      languages: 'en|pt|es|fr|de|id|th|ja|ko|ar',
      format: 'json',
    });
    const payload = await fetchJson(`https://www.wikidata.org/w/api.php?${params.toString()}`, {
      timeoutMs: 10000,
    });

    for (const [id, entity] of Object.entries(payload?.entities || {})) {
      entities.set(id, entity);
    }
  }

  return entities;
}

async function fetchWikidataLabels(ids) {
  if (ids.length === 0) {
    return new Map();
  }

  const labels = new Map();
  const entities = await fetchWikidataEntities(ids);
  for (const [id, entity] of entities.entries()) {
    labels.set(id, preferredLanguageValue(entity.labels));
  }
  return labels;
}

function wikidataSitelink(entity) {
  const sitelinks = entity?.sitelinks || {};
  const preferred = [
    'enwiki',
    'ptwiki',
    'eswiki',
    'frwiki',
    'dewiki',
    'idwiki',
    'thwiki',
    'jawiki',
    'kowiki',
    'arwiki',
  ].find((key) => sitelinks[key]?.title);

  if (preferred) {
    return {
      language: preferred.replace(/wiki$/, ''),
      title: sitelinks[preferred].title,
      url: sitelinks[preferred].url,
    };
  }

  const fallbackKey = Object.keys(sitelinks).find((key) => key.endsWith('wiki') && sitelinks[key]?.title);
  if (!fallbackKey) return null;

  return {
    language: fallbackKey.replace(/wiki$/, ''),
    title: sitelinks[fallbackKey].title,
    url: sitelinks[fallbackKey].url,
  };
}

async function fetchWikipediaSummary(sitelink) {
  if (!sitelink?.language || !sitelink?.title) {
    return null;
  }

  const title = encodeURIComponent(sitelink.title.replace(/ /g, '_'));
  const payload = await fetchJson(
    `https://${sitelink.language}.wikipedia.org/api/rest_v1/page/summary/${title}`,
    { timeoutMs: 7000 },
  );

  return {
    title: payload?.title || sitelink.title,
    extract: String(payload?.extract || '').slice(0, 900),
    description: payload?.description || '',
    url: payload?.content_urls?.desktop?.page || sitelink.url || '',
  };
}

function wikidataGenreIds(entity) {
  return (entity?.claims?.P136 || [])
    .map((claim) => claim?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

async function lookupExternalArtistMetadataByName(name) {
  const cacheKey = externalCacheKey(name);
  if (externalArtistMetadataCache.has(cacheKey)) {
    return externalArtistMetadataCache.get(cacheKey);
  }

  const result = {
    name,
    tags: [],
    genres: [],
    descriptions: [],
    sources: [],
    links: [],
  };

  const [musicBrainz, wikidata] = await Promise.allSettled([
    searchMusicBrainzArtist(name),
    searchWikidataArtist(name),
  ]);

  if (musicBrainz.status === 'fulfilled' && musicBrainz.value) {
    result.tags.push(...musicBrainz.value.tags);
    result.descriptions.push(musicBrainz.value.description);
    result.sources.push('MusicBrainz');
    if (musicBrainz.value.url) {
      result.links.push({ source: 'MusicBrainz', url: musicBrainz.value.url });
    }
  }

  if (wikidata.status === 'fulfilled' && wikidata.value) {
    result.descriptions.push(wikidata.value.description);
    result.sources.push('Wikidata');
    result.links.push({ source: 'Wikidata', url: wikidata.value.url });

    try {
      const entityMap = await fetchWikidataEntities([wikidata.value.id]);
      const entity = entityMap.get(wikidata.value.id);
      const genreIds = wikidataGenreIds(entity);
      const genreLabels = await fetchWikidataLabels(genreIds);
      result.genres.push(...genreLabels.values());
      result.tags.push(...genreLabels.values());
      result.descriptions.push(preferredLanguageValue(entity?.descriptions));

      const summary = await fetchWikipediaSummary(wikidataSitelink(entity)).catch(() => null);
      if (summary) {
        result.descriptions.push(summary.description, summary.extract);
        result.sources.push('Wikipedia');
        if (summary.url) {
          result.links.push({ source: 'Wikipedia', url: summary.url });
        }
      }
    } catch (_error) {
      // Wikidata search descriptions are still useful when entity expansion fails.
    }
  }

  const hasGenreSignal = result.tags.length > 0 || result.genres.length > 0;
  if (!hasGenreSignal) {
    const viberate = await fetchViberateArtistMetadata(name).catch(() => null);
    if (viberate) {
      result.tags.push(...viberate.tags);
      result.genres.push(...viberate.genres);
      result.descriptions.push(...viberate.descriptions);
      result.sources.push(viberate.source);
      result.links.push({ source: viberate.source, url: viberate.url });
    }
  }

  const normalized = {
    name,
    tags: uniqueStrings(result.tags),
    genres: uniqueStrings(result.genres),
    descriptions: uniqueStrings(result.descriptions).filter(Boolean),
    sources: uniqueStrings(result.sources),
    links: result.links.filter((link) => link.url),
  };

  externalArtistMetadataCache.set(cacheKey, normalized);
  return normalized;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export async function fetchExternalArtistMetadata(artists) {
  const inputs = normalizeExternalArtists(artists);
  return mapWithConcurrency(inputs, 5, async (artist) => {
    const metadata = await lookupExternalArtistMetadataByName(artist.name).catch(() => ({
      name: artist.name,
      tags: [],
      genres: [],
      descriptions: [],
      sources: [],
      links: [],
    }));

    return {
      id: artist.id,
      name: artist.name,
      ...metadata,
    };
  });
}

export async function fetchExternalTrackMetadata(tracks) {
  const inputs = normalizeExternalTracks(tracks);
  const results = await mapWithConcurrency(inputs, 2, async (track) => {
    const metadata = await lookupExternalTrackMetadata(track).catch(() => ({
      title: track.title,
      artist: track.artist,
      genres: [],
      tags: [],
      descriptions: [],
      sources: [],
      links: [],
      countryCode: '',
      matchScore: 0,
    }));

    return {
      id: track.id,
      inputTitle: track.title,
      inputArtist: track.artist,
      ...metadata,
    };
  });

  const genreHints = new Map();
  for (const result of results) {
    if (!result?.genres?.length) continue;
    const input = inputs.find((track) => track.id === result.id);
    if (!input) continue;
    const hint = {
      genres: result.genres,
      tags: result.tags || result.genres,
      countryCode: result.countryCode || '',
    };
    genreHints.set(trackArtistGenreCacheKey(input.artist), hint);
    for (const countryCode of input.countryCodes || []) {
      genreHints.set(trackArtistGenreCacheKey(input.artist, countryCode), hint);
    }
  }

  return results.map((result) => {
    if (result?.genres?.length) {
      return result;
    }

    const input = inputs.find((track) => track.id === result.id);
    if (!input) {
      return result;
    }

    const hint = ['', ...(input.countryCodes || [])]
      .map((countryCode) => genreHints.get(trackArtistGenreCacheKey(input.artist, countryCode)))
      .find((candidate) => candidate?.genres?.length);

    if (!hint) {
      return result;
    }

    return {
      ...result,
      genres: hint.genres,
      tags: hint.tags || hint.genres,
      descriptions: ['Apple/iTunes current-chart artist genre propagation'],
      sources: ['Apple/iTunes'],
      countryCode: hint.countryCode,
      matchScore: 9,
    };
  });
}

async function fetchArtistMetadata(artistIds) {
  const ids = normalizeSpotifyIds(artistIds);
  const missingIds = ids.filter((id) => !artistMetadataCache.has(id));

  for (let index = 0; index < missingIds.length; index += 50) {
    const chunk = missingIds.slice(index, index + 50);
    const params = new URLSearchParams({ ids: chunk.join(',') });
    const payload = await spotifyRequest(`/artists?${params.toString()}`);

    for (const artist of payload?.artists || []) {
      if (!artist?.id) continue;
      artistMetadataCache.set(artist.id, {
        id: artist.id,
        name: artist.name || '',
        genres: Array.isArray(artist.genres) ? artist.genres : [],
        popularity: artist.popularity ?? null,
      });
    }

    for (const id of chunk) {
      if (!artistMetadataCache.has(id)) {
        artistMetadataCache.set(id, {
          id,
          name: '',
          genres: [],
          popularity: null,
        });
      }
    }
  }

  return ids.map((id) => artistMetadataCache.get(id)).filter(Boolean);
}

async function searchSpotifyTrack(seed) {
  const queries = [
    `track:"${seed.track}" artist:"${seed.artist}"`,
    `${seed.artist} ${seed.track}`,
    `${seed.track} ${seed.artist}`,
  ];
  const seenIds = new Set();
  let best = null;
  let bestScore = -Infinity;

  for (const query of queries) {
    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: '10',
    });
    const payload = await spotifyRequest(`/search?${params.toString()}`);

    for (const item of payload?.tracks?.items || []) {
      if (!item?.uri || seenIds.has(item.id)) continue;
      seenIds.add(item.id);

      const score = scoreSpotifyTrackMatch(item, seed);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }

    if (bestScore >= 15) break;
  }

  if (!best || bestScore < 5) {
    return null;
  }

  return { item: best, score: Number(bestScore.toFixed(2)) };
}

function spotifyArtistProfileFromItem(item, seed) {
  if (!item?.id) {
    return null;
  }

  return {
    id: seed.id,
    spotifyId: item.id,
    name: item.name || seed.name,
    imageUrl: item.images?.[0]?.url || '',
    spotifyUrl: item.external_urls?.spotify || `https://open.spotify.com/artist/${item.id}`,
    popularity: item.popularity ?? null,
    followersTotal: item.followers?.total ?? null,
    genres: Array.isArray(item.genres) ? item.genres.slice(0, 8) : [],
  };
}

function cacheRisingArtistProfile(seed, profile) {
  risingArtistProfileCache.set(seed.id, {
    profile,
    expiresAt: Date.now() + RISING_ARTIST_PROFILE_CACHE_TTL,
  });
}

async function searchSpotifyArtistProfile(seed) {
  const params = new URLSearchParams({
    q: seed.name,
    type: 'artist',
    limit: '5',
  });
  const payload = await spotifyPublicRequest(`/search?${params.toString()}`);
  const candidates = payload?.artists?.items || [];
  const normalizedSeed = normalizeSearchText(seed.name);
  const best =
    candidates.find((artist) => normalizeSearchText(artist.name) === normalizedSeed) ||
    candidates[0];

  return spotifyArtistProfileFromItem(best, seed);
}

async function fetchRisingArtistProfiles(seeds) {
  const now = Date.now();
  const missing = [];

  for (const seed of seeds) {
    const cached = risingArtistProfileCache.get(seed.id);
    if (cached && cached.expiresAt > now) continue;
    missing.push(seed);
  }

  const directSeeds = missing.filter((seed) => /^[A-Za-z0-9]{22}$/.test(seed.id));
  await Promise.all(
    directSeeds.map(async (seed) => {
      try {
        const artist = await spotifyPublicRequest(`/artists/${encodeURIComponent(seed.id)}`);
        const profile = spotifyArtistProfileFromItem(artist, seed);

        if (profile) {
          cacheRisingArtistProfile(seed, profile);
        }
      } catch (_error) {
        // Search fallback below handles IDs that cannot be fetched directly.
      }
    }),
  );

  for (const seed of missing) {
    const cached = risingArtistProfileCache.get(seed.id);
    if (cached && cached.expiresAt > Date.now()) continue;

    try {
      const profile = await searchSpotifyArtistProfile(seed);
      if (profile) {
        cacheRisingArtistProfile(seed, profile);
      }
    } catch (_error) {
      // Artist images are a best-effort UI enhancement.
    }
  }

  return seeds
    .map((seed) => risingArtistProfileCache.get(seed.id)?.profile)
    .filter(Boolean);
}

function normalizeTasteTracks(tracks) {
  return Array.isArray(tracks)
    ? tracks
        .map((track) => ({
          id: String(track?.id || '').trim(),
          title: String(track?.title || '').trim(),
          artist: String(track?.artist || '').trim(),
          url: String(track?.url || '').trim(),
          countryCode: String(track?.countryCode || track?.country?.code || '')
            .trim()
            .toUpperCase(),
        }))
        .filter((track) => /^[A-Za-z0-9]{22}$/.test(track.id) && track.title && track.artist)
        .slice(0, 80)
    : [];
}

function unavailableTasteTrackProfile(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    imageUrl: '',
    previewUrl: '',
    sourceUrl: track.url || '',
    embedUrl: '',
    provider: 'unavailable',
    providerLabel: 'Preview unavailable',
    playable: false,
  };
}

function highResolutionItunesArtwork(url) {
  return String(url || '').replace(/\/\d+x\d+bb\.(jpg|png|webp)$/i, '/600x600bb.$1');
}

function itunesCountryCandidates(track) {
  return [
    track.countryCode,
    'US',
    'GB',
    'BR',
    'KR',
    'JP',
    'DE',
    'FR',
    'SE',
    'MX',
  ]
    .filter((countryCode) => /^[A-Z]{2}$/.test(countryCode || ''))
    .filter((countryCode, index, values) => values.indexOf(countryCode) === index)
    .slice(0, 6);
}

function tasteTrackProfileFromItunesItem(item, input, matchScore) {
  return {
    id: input.id,
    title: item.trackName || input.title,
    artist: item.artistName || input.artist,
    imageUrl: highResolutionItunesArtwork(item.artworkUrl100 || item.artworkUrl60 || ''),
    previewUrl: item.previewUrl || '',
    sourceUrl: item.trackViewUrl || input.url || `https://open.spotify.com/track/${input.id}`,
    embedUrl: '',
    provider: 'apple',
    providerLabel: 'Apple Music Preview',
    playable: Boolean(item.previewUrl),
    matchScore,
  };
}

async function searchItunesTasteTrackProfile(track) {
  let best = null;
  let bestScore = -Infinity;
  const countries = itunesCountryCandidates(track);

  const payloads = await mapWithConcurrency(countries, 3, async (country) => {
    const params = new URLSearchParams({
      term: `${track.artist} ${track.title}`,
      media: 'music',
      entity: 'song',
      country,
      limit: '10',
    });

    let payload = null;
    try {
      payload = await fetchJson(`https://itunes.apple.com/search?${params.toString()}`, {
        timeoutMs: 7000,
      });
    } catch (_error) {
      return [];
    }

    return Array.isArray(payload?.results) ? payload.results : [];
  });

  for (const candidates of payloads) {
    for (const item of candidates) {
      if (!item?.previewUrl) continue;
      if (!isItunesTasteArtistCompatible(item, track)) continue;
      if (!isItunesTasteTrackCompatible(item, track)) continue;

      const score = scoreItunesSongMatch(item, track);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
  }

  if (!best || bestScore < ITUNES_TASTE_PREVIEW_MATCH_THRESHOLD) {
    return null;
  }

  return tasteTrackProfileFromItunesItem(best, track, Number(bestScore.toFixed(2)));
}

async function fetchTasteTrackProfiles(tracks) {
  const inputs = normalizeTasteTracks(tracks);
  const now = Date.now();
  const missing = inputs.filter((track) => {
    const cached = tasteTrackProfileCache.get(track.id);
    return !cached || cached.expiresAt <= now;
  });

  await mapWithConcurrency(missing, 4, async (track) => {
    try {
      const appleProfile = await searchItunesTasteTrackProfile(track);
      const profile = appleProfile?.previewUrl ? appleProfile : unavailableTasteTrackProfile(track);

      tasteTrackProfileCache.set(track.id, {
        profile,
        expiresAt:
          Date.now() +
          (profile.previewUrl ? TASTE_TRACK_PROFILE_CACHE_TTL : TASTE_UNAVAILABLE_PROFILE_CACHE_TTL),
      });
    } catch (_error) {
      tasteTrackProfileCache.set(track.id, {
        profile: unavailableTasteTrackProfile(track),
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
    }
  });

  return inputs.map(
    (track) => tasteTrackProfileCache.get(track.id)?.profile || unavailableTasteTrackProfile(track),
  );
}

async function findOwnedPlaylistByName(name) {
  const userId = await getSpotifyUserId();
  let nextPath = '/me/playlists?limit=50';

  while (nextPath) {
    const payload = await spotifyRequest(nextPath);
    const match = (payload.items || []).find(
      (playlist) => playlist?.owner?.id === userId && playlist?.name === name,
    );

    if (match) {
      return match;
    }

    nextPath = payload.next ? payload.next.replace('https://api.spotify.com/v1', '') : null;
  }

  return null;
}

async function createPlaylistFromTracks({ name, description, trackUris, isPublic }) {
  // Pressing the same create button twice should refresh the existing playlist
  // instead of stacking same-name duplicates on the account.
  const existing = await findOwnedPlaylistByName(name).catch(() => null);

  if (existing) {
    await spotifyRequest(`/playlists/${existing.id}/items`, {
      method: 'PUT',
      body: { uris: trackUris.slice(0, 100) },
    });

    for (let index = 100; index < trackUris.length; index += 100) {
      await spotifyRequest(`/playlists/${existing.id}/items`, {
        method: 'POST',
        body: { uris: trackUris.slice(index, index + 100) },
      });
    }

    if (description && description !== existing.description) {
      await spotifyRequest(`/playlists/${existing.id}`, {
        method: 'PUT',
        body: { description },
      }).catch(() => {});
    }

    rememberPlaylistTrackCount(existing.id, trackUris.length);
    playlistCache = { data: null, expiresAt: 0 };

    return {
      id: existing.id,
      name: existing.name,
      description: description || existing.description || '',
      tracksTotal: trackUris.length,
      reused: true,
      openUrl:
        existing.external_urls?.spotify || `https://open.spotify.com/playlist/${existing.id}`,
      embedUrl: `https://open.spotify.com/embed/playlist/${existing.id}?utm_source=generator`,
    };
  }

  const playlist = await spotifyRequest('/me/playlists', {
    method: 'POST',
    body: {
      name,
      description,
      public: isPublic,
    },
  });

  try {
    for (let index = 0; index < trackUris.length; index += 100) {
      await spotifyRequest(`/playlists/${playlist.id}/items`, {
        method: 'POST',
        body: { uris: trackUris.slice(index, index + 100) },
      });
    }
  } catch (error) {
    await spotifyRequest(`/playlists/${playlist.id}/followers`, {
      method: 'DELETE',
    }).catch(() => {});
    throw error;
  }

  rememberPlaylistTrackCount(playlist.id, trackUris.length);
  playlistCache = { data: null, expiresAt: 0 };

  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description || '',
    tracksTotal: trackUris.length,
    openUrl:
      playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`,
    embedUrl: `https://open.spotify.com/embed/playlist/${playlist.id}?utm_source=generator`,
  };
}

function formatApiError(error) {
  if (error?.statusCode === 403) {
    return [
      'Spotify playlist 생성 권한이 부족합니다.',
      'Spotify 토큰을 playlist-modify-private 또는 playlist-modify-public scope로 다시 인증해야 합니다.',
      `원문: ${error.responseBody || error.message}`,
    ].join(' ');
  }

  return error instanceof Error ? error.message : String(error);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function headerValue(req, name) {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value ? String(value) : '';
}

function clientIpFromRequest(req) {
  const cfConnectingIp = headerValue(req, 'cf-connecting-ip');
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const forwardedFor = headerValue(req, 'x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() || '';
  }

  return headerValue(req, 'x-real-ip') || req.socket?.remoteAddress || '';
}

function requestAuditSummary(req) {
  return {
    method: req.method || '',
    host: headerValue(req, 'host'),
    remoteAddress: req.socket?.remoteAddress || '',
    clientIp: clientIpFromRequest(req),
    realIp: headerValue(req, 'x-real-ip'),
    forwardedFor: headerValue(req, 'x-forwarded-for'),
    cfConnectingIp: headerValue(req, 'cf-connecting-ip'),
    cfCountry: headerValue(req, 'cf-ipcountry'),
    cfRay: headerValue(req, 'cf-ray'),
    userAgent: headerValue(req, 'user-agent'),
    referer: headerValue(req, 'referer'),
    origin: headerValue(req, 'origin'),
  };
}

function logPlaylistWriteAudit(action, req, status) {
  console.warn(
    `[audit.playlistWrite.${status}] ${action} ${JSON.stringify(requestAuditSummary(req))}`,
  );
}

function requirePlaylistWriteAccess(req, res, action) {
  if (publicPlaylistWritesEnabled) {
    logPlaylistWriteAudit(action, req, 'allowed');
    return true;
  }

  logPlaylistWriteAudit(action, req, 'blocked');
  sendJson(res, 403, {
    error:
      'Public playlist write actions are disabled. Playlist creation requires an authenticated owner flow.',
  });
  return false;
}

function shouldLogAccess(req, routePath) {
  if (!accessLoggingEnabled) {
    return false;
  }

  if (routePath === '/api/audit/event') {
    return false;
  }

  if (routePath.startsWith('/api/')) {
    return true;
  }

  if (req.method !== 'GET') {
    return true;
  }

  if (routePath === '/' || routePath === '') {
    return true;
  }

  if (routePath.startsWith('/assets/') || routePath.startsWith('/data/')) {
    return false;
  }

  return path.extname(routePath) === '';
}

function logAccessOnFinish(req, res, routePath, requestUrl) {
  if (!shouldLogAccess(req, routePath)) {
    return;
  }

  const startedAt = Date.now();
  const category = routePath.startsWith('/api/') ? 'api' : 'page';
  res.on('finish', () => {
    console.info(
      `[audit.access] ${JSON.stringify({
        at: new Date().toISOString(),
        category,
        method: req.method || '',
        host: headerValue(req, 'host'),
        path: routePath,
        queryKeys: [...requestUrl.searchParams.keys()].slice(0, 12),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        ...requestAuditSummary(req),
      })}`,
    );
  });
}

function sanitizeAuditEventPayload(payload) {
  const safeString = (value, limit = 120) =>
    typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').slice(0, limit) : '';

  return {
    event: safeString(payload?.event, 80),
    visitId: safeString(payload?.visitId, 80),
    tab: safeString(payload?.tab, 40),
    locale: safeString(payload?.locale, 12),
    theme: safeString(payload?.theme, 12),
    snapshotDate: safeString(payload?.snapshotDate, 20),
    path: safeString(payload?.path, 160),
  };
}

async function handleClientAuditEvent(req, res) {
  if (!clientAuditEventsEnabled) {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const body = await readJsonBody(req);
    const event = sanitizeAuditEventPayload(body);
    if (!event.event) {
      sendJson(res, 400, { error: 'event is required' });
      return;
    }

    console.info(
      `[audit.clientEvent] ${JSON.stringify({
        at: new Date().toISOString(),
        ...event,
        ...requestAuditSummary(req),
      })}`,
    );
    res.writeHead(204);
    res.end();
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatCrawlerNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '';
}

const jsonFileCache = new Map();

function readJsonFile(filePath) {
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = jsonFileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.data;
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  jsonFileCache.set(filePath, { mtimeMs, data });
  return data;
}

function resolvePublicDataFile(publicDataPath) {
  const normalizedPath = String(publicDataPath || '').replace(/^\/+/, '');
  const resolvedPath = path.resolve(publicDir, normalizedPath);
  if (!resolvedPath.startsWith(path.resolve(publicDir))) {
    return null;
  }
  return fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile() ? resolvedPath : null;
}

function crawlerSummaryFallbackHtml() {
  return [
    '<!-- chart-atlas-crawler-summary:start -->',
    '<section id="crawler-chart-summary" data-crawler-summary>',
    '<h2>Latest chart snapshot</h2>',
    '<p>Chart Atlas stores weekly country chart snapshots and compares songs, artists, regions, and genre signals across markets. The interactive app loads the newest available snapshot when JavaScript is available.</p>',
    '</section>',
    '<!-- chart-atlas-crawler-summary:end -->',
  ].join('\n');
}

function buildCrawlerChartSummaryHtml() {
  try {
    const indexPath = path.join(publicDir, 'data', 'snapshot-index.json');
    if (!fs.existsSync(indexPath)) {
      return crawlerSummaryFallbackHtml();
    }

    const snapshotIndex = readJsonFile(indexPath);
    const snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
    const latestEntry =
      snapshots.find((entry) => entry.date === snapshotIndex.latestDate) ||
      snapshots[0];

    if (!latestEntry?.file) {
      return crawlerSummaryFallbackHtml();
    }

    const snapshotPath = resolvePublicDataFile(latestEntry.file);
    if (!snapshotPath) {
      return crawlerSummaryFallbackHtml();
    }

    const indexMtime = fs.statSync(indexPath).mtimeMs;
    const snapshotMtime = fs.statSync(snapshotPath).mtimeMs;
    const cacheKey = `${latestEntry.date}:${indexMtime}:${snapshotMtime}`;
    if (crawlerSummaryCache.key === cacheKey && crawlerSummaryCache.html) {
      return crawlerSummaryCache.html;
    }

    const snapshot = readJsonFile(snapshotPath);
    const trackById = new Map((snapshot.tracks || []).map((track) => [track.id, track]));
    const countryByCode = new Map((snapshot.countries || []).map((country) => [country.code, country]));
    const countryNumberOnes = (snapshot.countryCharts || [])
      .map((chart) => {
        const entry = Array.isArray(chart.entries) ? chart.entries[0] : null;
        const track = entry ? trackById.get(entry.trackId) : null;
        const country = countryByCode.get(chart.countryCode);
        if (!entry || !track || !country) return null;
        return { country, entry, track };
      })
      .filter(Boolean);

    const repeatedTracks = [...countryNumberOnes.reduce((map, item) => {
      const current =
        map.get(item.track.id) ||
        {
          track: item.track,
          countries: [],
          streams: 0,
        };
      current.countries.push(item.country.name);
      current.streams += Number(item.entry.streams || 0);
      map.set(item.track.id, current);
      return map;
    }, new Map()).values()]
      .sort((a, b) => b.countries.length - a.countries.length || b.streams - a.streams)
      .slice(0, 8);

    const countryItems = countryNumberOnes
      .slice(0, 40)
      .map((item) => {
        const streams = item.entry.streams
          ? `, ${formatCrawlerNumber(item.entry.streams)} streams`
          : '';
        return `<li><strong>${escapeHtml(item.country.name)}</strong> #1: ${escapeHtml(item.track.title)} by ${escapeHtml(item.track.artist)}${streams}</li>`;
      })
      .join('\n');

    const repeatedItems = repeatedTracks
      .map((item) => {
        const countryList = item.countries.slice(0, 6).join(', ');
        const suffix = item.countries.length > 6 ? ` and ${item.countries.length - 6} more` : '';
        return `<li><strong>${escapeHtml(item.track.title)}</strong> by ${escapeHtml(item.track.artist)} led ${item.countries.length} countries: ${escapeHtml(countryList)}${escapeHtml(suffix)}</li>`;
      })
      .join('\n');

    const generatedAt = snapshot.generatedAt
      ? new Date(snapshot.generatedAt).toISOString().slice(0, 10)
      : '';
    const html = [
      '<!-- chart-atlas-crawler-summary:start -->',
      '<section id="crawler-chart-summary" data-crawler-summary>',
      '<h2>Latest chart snapshot</h2>',
      `<p><strong>Current data week:</strong> ${escapeHtml(snapshot.snapshotDate || latestEntry.date)}. Source: ${escapeHtml(snapshot.sourceName || latestEntry.sourceName || 'country chart snapshot')}${generatedAt ? `. Generated ${escapeHtml(generatedAt)}` : ''}. Coverage: ${formatCrawlerNumber((snapshot.countries || []).length)} countries and ${formatCrawlerNumber((snapshot.tracks || []).length)} charting tracks.</p>`,
      '<h3>Country #1 songs in the current snapshot</h3>',
      `<ul>${countryItems}</ul>`,
      '<h3>Songs leading multiple countries</h3>',
      repeatedItems ? `<ul>${repeatedItems}</ul>` : '<p>No repeated #1 songs were found in the current snapshot.</p>',
      '<h3>Read the crawlable research pages</h3>',
      `<ul><li><a href="/weekly/${escapeHtml(snapshot.snapshotDate || latestEntry.date)}">Weekly chart report for ${escapeHtml(snapshot.snapshotDate || latestEntry.date)}</a></li><li><a href="/countries/us">United States country chart report</a></li><li><a href="/countries/br">Brazil country chart report</a></li><li><a href="/genres/pop">Pop genre signal report</a></li><li><a href="/genres/sertanejo">Sertanejo genre signal report</a></li><li><a href="/genres">All genre signal reports</a></li></ul>`,
      '<p>Interactive views add the world map, country Top 10 board, week-over-week movement, genre discovery, rising discovery, taste sampling, and playlist creation on top of this crawlable chart summary.</p>',
      '</section>',
      '<!-- chart-atlas-crawler-summary:end -->',
    ].join('\n');

    crawlerSummaryCache = { key: cacheKey, html };
    return html;
  } catch (error) {
    console.error(`[crawler.summary] ${error instanceof Error ? error.message : String(error)}`);
    return crawlerSummaryFallbackHtml();
  }
}

function injectCrawlerChartSummary(html) {
  return html.replace(
    /<!-- chart-atlas-crawler-summary:start -->[\s\S]*?<!-- chart-atlas-crawler-summary:end -->/,
    buildCrawlerChartSummaryHtml(),
  );
}

function safeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function buildInitialDataScript() {
  try {
    const snapshotIndex = loadSnapshotIndex();
    const latestEntry = resolveSnapshotEntry();
    const latestSnapshot = loadSnapshotFromEntry(latestEntry);

    if (!latestSnapshot || !snapshotIndex.snapshots.length) {
      return '';
    }

    const payload = {
      schemaVersion: 1,
      snapshotIndex,
      latestSnapshot,
    };

    // Preload the previous week's snapshot so week-over-week movement badges
    // resolve almost immediately after hydration. Inlining the whole previous
    // snapshot would add ~670KB to every HTML response, so a preload hint is
    // the better trade-off. The ?v= param must mirror the client fetch exactly.
    const sortedEntries = [...snapshotIndex.snapshots].sort((a, b) =>
      String(b.date).localeCompare(String(a.date)),
    );
    const latestPosition = sortedEntries.findIndex((entry) => entry.date === latestEntry.date);
    const previousEntry = latestPosition >= 0 ? sortedEntries[latestPosition + 1] : undefined;
    const previousPreload = previousEntry?.file
      ? `<link rel="preload" href="${escapeHtml(previousEntry.file)}?v=${encodeURIComponent(previousEntry.generatedAt || previousEntry.date)}" as="fetch" crossorigin="anonymous">\n`
      : '';

    return `${previousPreload}<script>window.__CHART_ATLAS_INITIAL_DATA__=${safeJsonForInlineScript(payload)};</script>`;
  } catch (error) {
    console.error(`[initial.data] ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

function injectInitialData(html) {
  return html.replace('<!-- chart-atlas-initial-data -->', buildInitialDataScript());
}

function sendHtml(res, statusCode, html, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}

function sendXml(res, statusCode, xml) {
  res.writeHead(statusCode, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(xml);
}

function escapeXml(value) {
  return escapeHtml(value);
}

function formatArticleNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US') : '0';
}

function formatArticleDate(value) {
  return String(value || '').slice(0, 10);
}

function loadSnapshotIndex() {
  const indexPath = path.join(publicDir, 'data', 'snapshot-index.json');
  if (!fs.existsSync(indexPath)) {
    return { latestDate: '', snapshots: [] };
  }

  const index = readJsonFile(indexPath);
  return {
    schemaVersion: index.schemaVersion || 1,
    latestDate: String(index.latestDate || ''),
    snapshots: Array.isArray(index.snapshots) ? index.snapshots : [],
  };
}

function resolveSnapshotEntry(date = '') {
  const index = loadSnapshotIndex();
  const snapshots = index.snapshots;
  if (!snapshots.length) {
    return null;
  }

  if (date) {
    return snapshots.find((entry) => entry.date === date) || null;
  }

  return snapshots.find((entry) => entry.date === index.latestDate) || snapshots[0] || null;
}

function loadSnapshotFromEntry(entry) {
  const filePath = entry?.file ? resolvePublicDataFile(entry.file) : null;
  return filePath ? readJsonFile(filePath) : null;
}

function loadAnalysisFromEntry(entry) {
  const analysisFile = entry?.analysisFile || `/data/analysis/${entry?.date}.json`;
  const filePath = entry?.date ? resolvePublicDataFile(analysisFile) : null;
  return filePath ? readJsonFile(filePath) : null;
}

function loadGenreDiscoveryForDate(date) {
  const filePath =
    resolvePublicDataFile(`/data/genre-discovery/${date}.json`) ||
    resolvePublicDataFile('/data/genre-discovery.json');
  return filePath ? readJsonFile(filePath) : null;
}

function genreMatchedTrackCount(signal) {
  const declaredCount = Number(signal?.matchedTrackCount);
  if (Number.isFinite(declaredCount)) {
    return Math.max(0, declaredCount);
  }
  return Array.isArray(signal?.matchedTracks) ? signal.matchedTracks.length : 0;
}

function genreSignalHasChartEvidence(signal) {
  return genreMatchedTrackCount(signal) > 0 && Number(signal?.chartPopularityScore || 0) > 0;
}

function genreSignalIsIndexable(signal) {
  return (
    genreSignalHasChartEvidence(signal) &&
    genreMatchedTrackCount(signal) >= MIN_INDEXABLE_GENRE_TRACKS
  );
}

const genreEditorialEnPath = path.join(__dirname, 'content', 'genre-editorial-en.json');

function genreEditorialEn(genreId) {
  if (!fs.existsSync(genreEditorialEnPath)) {
    return null;
  }

  try {
    const editorial = readJsonFile(genreEditorialEnPath);
    const entry = editorial?.[genreId];
    return entry && typeof entry === 'object' ? entry : null;
  } catch (error) {
    console.error(`[genre.editorial] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function loadWeeklyEditorialNote(date) {
  if (!date || !fs.existsSync(weeklyEditorialNotesPath)) {
    return null;
  }

  try {
    const notes = readJsonFile(weeklyEditorialNotesPath);
    const note = notes?.[date];
    return note && typeof note === 'object' ? note : null;
  } catch (error) {
    console.error(`[weekly.editorial] ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function previousSnapshotEntry(date) {
  const snapshots = loadSnapshotIndex().snapshots;
  const index = snapshots.findIndex((entry) => entry.date === date);
  return index >= 0 ? snapshots[index + 1] || null : null;
}

function loadGenreDiscoveryForDateStrict(date) {
  const filePath = date ? resolvePublicDataFile(`/data/genre-discovery/${date}.json`) : null;
  return filePath ? readJsonFile(filePath) : null;
}

function aggregateTrackStatsMap(analysis) {
  return new Map((analysis?.trackStats || []).map((stat) => [stat.trackId, stat]));
}

function loadSnapshotHistory(limit = 16) {
  return loadSnapshotIndex()
    .snapshots.slice(0, limit)
    .map((entry) => ({ entry, snapshot: loadSnapshotFromEntry(entry) }))
    .filter((item) => item.snapshot);
}

function countryChartChurn(currentSnapshot, previousSnapshot, countryCode) {
  const currentEntries = chartForCountry(currentSnapshot, countryCode)?.entries || [];
  const previousEntries = chartForCountry(previousSnapshot, countryCode)?.entries || [];
  if (!currentEntries.length || !previousEntries.length) {
    return null;
  }

  const previousIds = new Set(previousEntries.map((entry) => entry.trackId));
  const newCount = currentEntries.filter((entry) => !previousIds.has(entry.trackId)).length;
  return newCount / currentEntries.length;
}

function trackByIdMap(snapshot) {
  return new Map((snapshot?.tracks || []).map((track) => [track.id, track]));
}

function countryByCodeMap(snapshot) {
  return new Map((snapshot?.countries || []).map((country) => [country.code, country]));
}

function chartForCountry(snapshot, countryCode) {
  return (snapshot?.countryCharts || []).find((chart) => chart.countryCode === countryCode) || null;
}

function entryMovement(entry, previousChart) {
  const previousEntry = (previousChart?.entries || []).find((item) => item.trackId === entry.trackId);
  if (!previousEntry) {
    return { label: 'new this week', detail: 'not present in this country chart last snapshot' };
  }

  const delta = previousEntry.rank - entry.rank;
  if (delta > 0) {
    return { label: `up ${delta}`, detail: `from #${previousEntry.rank}` };
  }
  if (delta < 0) {
    return { label: `down ${Math.abs(delta)}`, detail: `from #${previousEntry.rank}` };
  }
  return { label: 'unchanged', detail: `held #${entry.rank}` };
}

function articlePage({
  title,
  description,
  canonicalPath,
  eyebrow = 'Chart Atlas report',
  robots = 'index, follow',
  body,
}) {
  const canonical = `https://foldalpha.com${canonicalPath}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="${escapeHtml(robots)}" />
    <meta name="google-adsense-account" content="ca-pub-1642219896856384" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta property="og:type" content="article" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; --ink:#172033; --muted:#64748b; --line:#dbe3ee; --panel:#ffffff; --wash:#f6f8fb; --accent:#0f766e; --accent-2:#db2777; }
      body { margin:0; font-family: ui-serif, Georgia, "Times New Roman", serif; color:var(--ink); background:linear-gradient(135deg,#f8fafc,#eef7f4 42%,#fff7ed); }
      a { color:var(--accent); text-decoration:none; font-weight:700; }
      a:hover { text-decoration:underline; }
      .shell { width:min(1120px, calc(100% - 32px)); margin:0 auto; padding:28px 0 48px; }
      .top { display:flex; justify-content:space-between; align-items:center; gap:18px; margin-bottom:30px; font-family: ui-sans-serif, system-ui, sans-serif; }
      .brand { color:var(--ink); font-size:18px; font-weight:900; letter-spacing:-.03em; }
      nav { display:flex; flex-wrap:wrap; gap:12px; font-size:13px; }
      article { background:rgba(255,255,255,.88); border:1px solid var(--line); border-radius:28px; padding:clamp(22px,4vw,48px); box-shadow:0 28px 70px rgba(15,23,42,.10); }
      .eyebrow { color:var(--accent); text-transform:uppercase; letter-spacing:.08em; font:900 12px/1 ui-sans-serif, system-ui, sans-serif; margin:0 0 12px; }
      h1 { margin:0; font-size:clamp(36px,6vw,72px); line-height:.96; letter-spacing:-.055em; }
      h2 { margin:36px 0 12px; font-size:clamp(24px,3vw,34px); letter-spacing:-.035em; }
      h3 { margin:24px 0 10px; font-size:20px; letter-spacing:-.02em; }
      p { color:#334155; font-size:17px; line-height:1.72; }
      .lede { color:#243145; font-size:20px; line-height:1.7; max-width:900px; }
      .meta { color:var(--muted); display:flex; flex-wrap:wrap; gap:8px; margin:20px 0 8px; font:800 13px/1 ui-sans-serif, system-ui, sans-serif; }
      .meta span, .pill { background:#f8fafc; border:1px solid var(--line); border-radius:999px; padding:8px 10px; }
      table { width:100%; border-collapse:collapse; margin:16px 0 26px; font-family: ui-sans-serif, system-ui, sans-serif; font-size:14px; }
      th, td { border-bottom:1px solid var(--line); padding:11px 9px; text-align:left; vertical-align:top; }
      th { color:#475569; font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
      ol, ul { color:#334155; font-size:16px; line-height:1.75; padding-left:24px; }
      .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin:18px 0; }
      .card { background:var(--wash); border:1px solid var(--line); border-radius:18px; padding:16px; }
      .card strong { display:block; font:900 22px/1.1 ui-sans-serif, system-ui, sans-serif; letter-spacing:-.03em; }
      .card small { color:var(--muted); display:block; margin-top:6px; font:760 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
      .note { background:#ecfdf5; border:1px solid #99f6e4; border-radius:18px; padding:16px; }
      footer { color:var(--muted); margin-top:24px; font:760 13px/1.6 ui-sans-serif, system-ui, sans-serif; }
      @media (max-width: 760px) { .top { align-items:flex-start; flex-direction:column; } article { border-radius:20px; } .grid { grid-template-columns:1fr; } th:nth-child(5), td:nth-child(5) { display:none; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="top">
        <a class="brand" href="/">Chart Atlas</a>
        <nav aria-label="Chart Atlas reports">
          <a href="/weekly">Weekly reports</a>
          <a href="/countries">Country reports</a>
          <a href="/genres">Genre reports</a>
          <a href="/methodology">Methodology</a>
          <a href="/privacy">Privacy</a>
        </nav>
      </header>
      <article>
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        ${body}
      </article>
      <footer>
        Chart Atlas publishes crawlable music chart research pages generated from weekly country chart snapshots. The interactive map and discovery tools are available on the <a href="/">home page</a>.
      </footer>
    </div>
  </body>
</html>`;
}

function contactEmailHtml() {
  return '<span>team [at] foldalpha.com</span>';
}

function reportIndexPage() {
  const index = loadSnapshotIndex();
  const latest = resolveSnapshotEntry();
  const snapshot = loadSnapshotFromEntry(latest);
  const genreData = latest ? loadGenreDiscoveryForDate(latest.date) : null;
  const countryLinks = (snapshot?.countries || [])
    .map((country) => `<li><a href="/countries/${country.code.toLowerCase()}">${escapeHtml(country.name)}</a> <span class="pill">${escapeHtml(country.region)}</span></li>`)
    .join('\n');
  const genreLinks = (genreData?.signals || [])
    .filter(genreSignalIsIndexable)
    .slice(0, 20)
    .map((signal) => `<li><a href="/genres/${escapeHtml(signal.genre.id)}">${escapeHtml(signal.genre.name)}</a> ranked #${formatArticleNumber(signal.rank)} in the latest genre signal table.</li>`)
    .join('\n');
  const weekLinks = index.snapshots
    .map((entry) => `<li><a href="/weekly/${entry.date}">${entry.date} weekly chart report</a> covering ${formatArticleNumber(entry.countries)} countries and ${formatArticleNumber(entry.tracks)} tracks.</li>`)
    .join('\n');

  return articlePage({
    title: 'Chart Atlas research reports',
    description: 'Browse weekly, country, and genre music chart reports generated from Chart Atlas country chart snapshots.',
    canonicalPath: '/weekly',
    eyebrow: 'Report index',
    body: `
      <h1>Chart Atlas research reports</h1>
      <p class="lede">These pages turn the Chart Atlas data warehouse into readable music chart research. Each report is generated from weekly country snapshots and adds context around top songs, country movement, genre signals, and methodology.</p>
      <div class="grid">
        <div class="card"><strong>${formatArticleNumber(index.snapshots.length)}</strong><small>weekly snapshots currently available</small></div>
        <div class="card"><strong>${formatArticleNumber((snapshot?.countries || []).length)}</strong><small>countries in the latest snapshot</small></div>
      </div>
      <h2>Weekly reports</h2>
      <ul>${weekLinks}</ul>
      <h2>Country reports</h2>
      <ul>${countryLinks}</ul>
      <h2>Genre reports</h2>
      <ul>${genreLinks}</ul>
    `,
  });
}

function aboutPage() {
  return articlePage({
    title: 'About Chart Atlas',
    description:
      'Chart Atlas is an editorial music discovery lab for country charts, genre signals, rising artists, taste exploration, and playlist research.',
    canonicalPath: '/about',
    eyebrow: 'About',
    body: `
      <h1>About Chart Atlas</h1>
      <p class="lede">Chart Atlas is a music discovery lab built around weekly country chart snapshots. It helps readers compare what is charting across markets, identify local genre signals, notice rising artists, and turn discoveries into playlist ideas.</p>
      <h2>What Chart Atlas Provides</h2>
      <ul>
        <li>Country chart maps and Top 10 boards for comparing songs across markets.</li>
        <li>Weekly reports that summarize cross-country songs, artists, and country #1 tracks.</li>
        <li>Country reports that explain local Top 10 movement and stream context.</li>
        <li>Genre reports based on current charting tracks and metadata evidence, not just fixed country assumptions.</li>
        <li>Rising and taste discovery tools for finding artists, tracks, and genres that are easy to miss in one-country charts.</li>
      </ul>
      <h2>Editorial Position</h2>
      <p>Chart Atlas is not a mirror of a single chart table. It reorganizes chart data into research pages and interactive views so readers can ask comparative questions: where is a song breaking first, which genres are overrepresented in local charts, and which artists are gaining multi-week momentum?</p>
      <h2>Data and Independence</h2>
      <p>The service uses collected chart snapshots, external music metadata, and public music platform links where available. Chart Atlas is not affiliated with or endorsed by Spotify, Apple Music, Google, or any listed music platform.</p>
      <h2>Contact</h2>
      <p>Questions, corrections, and data feedback can be sent to ${contactEmailHtml()}.</p>
    `,
  });
}

function privacyPage() {
  return articlePage({
    title: 'Privacy Policy | Chart Atlas',
    description:
      'Privacy policy for Chart Atlas, including chart data, service logs, playlist requests, external services, advertising, and contact information.',
    canonicalPath: '/privacy',
    eyebrow: 'Privacy policy',
    body: `
      <h1>Privacy Policy</h1>
      <p class="meta"><span>Effective date: June 26, 2026</span><span>Contact: ${contactEmailHtml()}</span></p>
      <p class="lede">Chart Atlas provides country music charts, genre discovery, public playlist browsing, and music research pages. We process only the information needed to operate, secure, troubleshoot, and improve the service.</p>
      <h2>Information We Process</h2>
      <ul>
        <li>Chart and genre pages: country chart data, track metadata, artist metadata, selected dates, selected countries, and selected genre views.</li>
        <li>Playlist tools: playlist task requests, selected tracks, generated playlist metadata, and public playlist lists when features are enabled.</li>
        <li>Service logs: request path, status code, user agent, referrer, approximate IP-related routing headers, processing time, and basic client events such as tab views.</li>
        <li>Advertising data: if ads are enabled, Google AdSense or other advertising partners may use cookies, device data, consent signals, and advertising identifiers according to their own policies.</li>
      </ul>
      <h2>Purpose of Processing</h2>
      <ul>
        <li>Display chart maps, weekly reports, country reports, genre reports, and discovery tools.</li>
        <li>Analyze service errors, prevent abuse, and improve performance.</li>
        <li>Operate playlist-related features and external music platform links where available.</li>
        <li>Serve, measure, and manage advertising if advertising is enabled.</li>
      </ul>
      <h2>Retention</h2>
      <p>Chart datasets and derived reports are retained as historical research snapshots. Server logs and cache data may be retained for the period needed to operate the service, diagnose incidents, and understand abuse patterns. Playlist chat/session data is intended to be temporary and may be reset by service maintenance or deployment.</p>
      <h2>Third-Party Services</h2>
      <p>Chart Atlas may use external services such as Spotify API, Apple Music preview metadata, OpenAI/Codex execution environments, Google AdSense, Cloudflare, and other metadata sources. Data handling by those services follows their own terms and privacy policies.</p>
      <h2>Your Choices</h2>
      <p>You can contact the site operator about privacy questions or correction requests at ${contactEmailHtml()}. Browser-level privacy controls, cookie controls, and ad-consent choices may also affect how third-party services operate.</p>
    `,
  });
}

function contactPage() {
  return articlePage({
    title: 'Contact Chart Atlas',
    description:
      'Contact Chart Atlas for service questions, privacy requests, advertising questions, playlist issues, or chart data corrections.',
    canonicalPath: '/contact',
    eyebrow: 'Contact',
    body: `
      <h1>Contact Chart Atlas</h1>
      <p class="lede">For service questions, chart corrections, genre feedback, playlist issues, privacy requests, or advertising questions, contact the Chart Atlas team by email.</p>
      <div class="grid">
        <div class="card"><strong>${contactEmailHtml()}</strong><small>Primary contact address for Chart Atlas</small></div>
        <div class="card"><strong>Data feedback</strong><small>Include the chart date, country, genre, artist, or track involved.</small></div>
      </div>
      <h2>What To Include</h2>
      <ul>
        <li>The page or feature where the issue happened.</li>
        <li>The chart date, country, genre, playlist, artist, or track involved if relevant.</li>
        <li>A short description of what you expected and what happened instead.</li>
        <li>For privacy requests, describe the request and the contact address we should use for follow-up.</li>
      </ul>
      <h2>Common Topics</h2>
      <p>Typical contact topics include chart data errors, genre mismatches, broken preview links, playlist creation issues, advertising or consent questions, and requests to clarify how a report was generated.</p>
      <p class="note">Chart Atlas is an independent music discovery service. It cannot modify official Spotify, Apple Music, YouTube, or chart-provider records.</p>
    `,
  });
}

function termsPage() {
  return articlePage({
    title: 'Terms and Usage Notes | Chart Atlas',
    description:
      'Terms and usage notes for Chart Atlas, an informational music chart and discovery service.',
    canonicalPath: '/terms',
    eyebrow: 'Terms',
    body: `
      <h1>Terms and Usage Notes</h1>
      <p class="meta"><span>Effective date: June 26, 2026</span></p>
      <p class="lede">Chart Atlas is provided as an informational and experimental music discovery service. It is intended for exploration, research, and playlist inspiration rather than professional advice or official chart certification.</p>
      <h2>Use of the Service</h2>
      <p>Chart rankings, genre classifications, rising signals, and playlist suggestions are generated from available snapshots, metadata, and external platform responses. They may contain errors, missing entries, outdated metadata, or genre overlap.</p>
      <h2>External Services</h2>
      <p>Playlist features and music links may use external services such as Spotify, Apple Music preview metadata, and other music metadata providers. Content, accounts, previews, embeds, and platform actions are governed by those services' own terms and policies.</p>
      <h2>No Professional Advice</h2>
      <p>The service does not provide legal, financial, advertising, music-industry, or professional advice. Users should verify important information independently before relying on it for business, editorial, or promotional decisions.</p>
      <h2>Acceptable Use</h2>
      <ul>
        <li>Do not use the service to abuse playlist APIs, automate spam, or impersonate artists or platforms.</li>
        <li>Do not attempt to access private server files, credentials, administrative endpoints, or unrelated infrastructure.</li>
        <li>Do not treat generated genre labels as official artist classifications or final cultural judgments.</li>
      </ul>
      <h2>Contact</h2>
      <p>Questions about these usage notes can be sent to ${contactEmailHtml()}.</p>
    `,
  });
}

function methodologyPage() {
  return articlePage({
    title: 'Data and Methodology | Chart Atlas',
    description:
      'Methodology for Chart Atlas weekly snapshots, country reports, genre discovery, rising discovery, taste discovery, and playlist research.',
    canonicalPath: '/methodology',
    eyebrow: 'Methodology',
    body: `
      <h1>Data and Methodology</h1>
      <p class="meta"><span>Last updated: July 9, 2026</span></p>
      <p class="lede">Chart Atlas is built as an editorial music-discovery tool. It does not simply mirror one ranking table. The service combines weekly country chart snapshots, track metadata, country-level appearances, rank movement, and genre evidence to help readers understand which songs, artists, and regional genres are gaining attention.</p>
      <h2>Chart Snapshots</h2>
      <p>The app stores dated chart snapshots so readers can compare the current week with previous weeks. Each snapshot includes countries, tracks, chart positions, movement data, and metadata used by the map, country Top 10 board, analysis table, and crawlable report pages.</p>
      <h2>Ranking Signals</h2>
      <ul>
        <li>A track gains more weight when it appears in more countries and ranks closer to #1.</li>
        <li>Country pages show local rank movement, including new entries and week-over-week changes.</li>
        <li>Artist rankings aggregate the chart performance of tracks connected to the same artist identity.</li>
        <li>Rising discovery emphasizes multi-week movement rather than a single-week spike.</li>
      </ul>
      <h2>Genre Discovery</h2>
      <p>Genre discovery uses charting tracks as the starting point. The system checks track titles, artists, external music metadata, local genre dictionaries, and chart-country context. This is designed to highlight both global categories such as hip-hop, pop, dance, and R&amp;B and local genres such as sertanejo, OPM, schlager, corridos tumbados, gqom, and mahraganat.</p>
      <h2>Taste Discovery</h2>
      <p>Taste Discovery selects playable Apple preview tracks from chart-driven genre candidates. Tracks without an Apple preview are excluded from the sampler so the experience stays focused on playable music rather than empty embeds or broken previews.</p>
      <h2>Limitations</h2>
      <p>Music metadata is imperfect. Artist aliases, remixes, local spelling, featured artists, unavailable previews, and genre overlap can cause omissions or misclassification. Chart Atlas treats the output as a discovery signal, not as an official industry chart or definitive genre authority.</p>
      <h2>Corrections</h2>
      <p>If you notice a chart issue, genre mismatch, missing credit, or playlist problem, send the details to ${contactEmailHtml()}.</p>
    `,
  });
}

function handleInfoPageRoute(req, res, routePath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  const pageByPath = {
    '/about': aboutPage,
    '/privacy': privacyPage,
    '/contact': contactPage,
    '/terms': termsPage,
    '/methodology': methodologyPage,
  };
  const buildPage = pageByPath[routePath];
  if (!buildPage) {
    return false;
  }

  const html = buildPage();
  if (req.method === 'HEAD') {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (html.includes('content="noindex, follow"')) {
      headers['X-Robots-Tag'] = 'noindex, follow';
    }
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  const headers = html.includes('content="noindex, follow"')
    ? { 'X-Robots-Tag': 'noindex, follow' }
    : {};
  sendHtml(res, 200, html, headers);
  return true;
}

function countriesIndexPage() {
  const entry = resolveSnapshotEntry();
  const snapshot = loadSnapshotFromEntry(entry);
  const countryByCode = countryByCodeMap(snapshot);
  const trackById = trackByIdMap(snapshot);
  const rows = (snapshot?.countryCharts || [])
    .map((chart) => {
      const country = countryByCode.get(chart.countryCode);
      const first = chart.entries?.[0];
      const track = first ? trackById.get(first.trackId) : null;
      if (!country || !track || !first) return '';
      return `<tr><td><a href="/countries/${country.code.toLowerCase()}">${escapeHtml(country.name)}</a></td><td>${escapeHtml(country.region)}</td><td>${escapeHtml(track.title)}</td><td>${escapeHtml(track.artist)}</td><td>#${formatArticleNumber(first.rank)}</td></tr>`;
    })
    .join('\n');

  return articlePage({
    title: 'Country music chart reports',
    description: 'Country-level Chart Atlas reports with top 10 songs, week-over-week movement, and local chart context.',
    canonicalPath: '/countries',
    eyebrow: 'Country reports',
    body: `
      <h1>Country music chart reports</h1>
      <p class="lede">Each country page summarizes the latest Top 10, compares it with the previous snapshot, and explains which songs are stable, rising, or newly visible in that market.</p>
      <div class="meta"><span>Latest week: ${escapeHtml(entry?.date || '')}</span><span>Coverage: ${formatArticleNumber((snapshot?.countries || []).length)} countries</span></div>
      <table>
        <thead><tr><th>Country</th><th>Region</th><th>Current #1</th><th>Artist</th><th>Rank</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  });
}

function genresIndexPage() {
  const entry = resolveSnapshotEntry();
  const genreData = entry ? loadGenreDiscoveryForDate(entry.date) : null;
  const indexableSignals = (genreData?.signals || []).filter(genreSignalIsIndexable);
  const rows = indexableSignals
    .map((signal) => `<tr><td>#${formatArticleNumber(signal.rank)}</td><td><a href="/genres/${escapeHtml(signal.genre.id)}">${escapeHtml(signal.genre.name)}</a></td><td>${escapeHtml(signal.genre.region || 'Global')}</td><td>${formatArticleNumber(Math.round(signal.chartPopularityScore || 0))}</td><td>${formatArticleNumber(genreMatchedTrackCount(signal))}</td></tr>`)
    .join('\n');

  return articlePage({
    title: 'Genre signal reports',
    description: 'Genre-level Chart Atlas reports ranking current chart genres from matched country chart songs.',
    canonicalPath: '/genres',
    eyebrow: 'Genre reports',
    body: `
      <h1>Genre signal reports</h1>
      <p class="lede">The genre reports explain how current country-chart songs map into global and local genre families. This index includes only genres supported by at least ${formatArticleNumber(MIN_INDEXABLE_GENRE_TRACKS)} matched chart songs and a positive score in the latest snapshot; thinner reference pages remain available but are deliberately excluded from search indexing.</p>
      <div class="meta"><span>Latest week: ${escapeHtml(entry?.date || '')}</span><span>${formatArticleNumber(indexableSignals.length)} evidence-backed genres</span><span>Score mode: ${escapeHtml(genreData?.scoreMode || 'rank weighted')}</span></div>
      <table>
        <thead><tr><th>Rank</th><th>Genre</th><th>Region</th><th>Score</th><th>Matched tracks</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `,
  });
}

function normalizeTrackIdentity(track) {
  return [track?.title, track?.artist]
    .map((value) =>
      String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim(),
    )
    .join('::');
}

function weeklyEditorialNoteSection(note) {
  if (!note) {
    return '';
  }

  const observations = Array.isArray(note.observations) ? note.observations : [];
  const observationHtml = observations
    .filter((item) => item?.heading && item?.body)
    .map(
      (item) => `
        <h3>${escapeHtml(item.heading)}</h3>
        <p>${escapeHtml(item.body)}</p>`,
    )
    .join('\n');

  return `
    <section aria-labelledby="chart-atlas-commentary">
      <h2 id="chart-atlas-commentary">Chart Atlas commentary</h2>
      <div class="meta"><span>Published: ${escapeHtml(formatArticleDate(note.publishedAt))}</span><span>Data interpretation</span></div>
      <h3>${escapeHtml(note.title || 'Notes on this snapshot')}</h3>
      <p>${escapeHtml(note.summary || '')}</p>
      ${observationHtml}
      <p class="note">${escapeHtml(note.disclosure || 'This commentary interprets the stored chart evidence. It separates observed movement from possible explanations and does not claim a cause that the data cannot prove.')}</p>
    </section>
  `;
}

function weeklyComparisonSection(entry, snapshot, analysis) {
  const previousEntry = previousSnapshotEntry(entry.date);
  const previousSnapshot = loadSnapshotFromEntry(previousEntry);
  const previousAnalysis = loadAnalysisFromEntry(previousEntry);
  if (!previousEntry || !previousSnapshot || !previousAnalysis) {
    return `
      <h2>Comparison baseline</h2>
      <p>This is the earliest stored Chart Atlas snapshot, so there is no previous week available for a like-for-like movement analysis.</p>
    `;
  }

  const currentStats = analysis.trackStats || [];
  const previousStats = previousAnalysis.trackStats || [];
  const currentStatsById = new Map(currentStats.map((track) => [track.trackId, track]));
  const previousStatsById = new Map(previousStats.map((track) => [track.trackId, track]));
  const leader = currentStats[0];
  const previousLeader = previousStats[0];
  const leaderPrevious = previousStatsById.get(leader?.trackId);
  const previousLeaderCurrent = currentStatsById.get(previousLeader?.trackId);

  const movers = currentStats
    .filter((track) => track.rank <= 100 && previousStatsById.has(track.trackId))
    .map((track) => ({
      track,
      previous: previousStatsById.get(track.trackId),
      delta: previousStatsById.get(track.trackId).rank - track.rank,
    }))
    .filter((item) => item.delta >= 10 && item.previous.rank <= 250)
    .sort((a, b) => b.delta - a.delta || a.track.rank - b.track.rank)
    .slice(0, 5);

  const newEntrants = currentStats
    .filter((track) => track.rank <= 100 && !previousStatsById.has(track.trackId))
    .slice(0, 5);

  const marketExpanders = currentStats
    .filter((track) => track.rank <= 100 && previousStatsById.has(track.trackId))
    .map((track) => ({
      track,
      previous: previousStatsById.get(track.trackId),
      delta: track.appearances - previousStatsById.get(track.trackId).appearances,
    }))
    .filter((item) => item.delta >= 2)
    .sort((a, b) => b.delta - a.delta || a.track.rank - b.track.rank)
    .slice(0, 5);

  const currentTracks = trackByIdMap(snapshot);
  const previousTracks = trackByIdMap(previousSnapshot);
  const previousCharts = new Map(
    (previousSnapshot.countryCharts || []).map((chart) => [chart.countryCode, chart]),
  );
  const countries = countryByCodeMap(snapshot);
  const countryLeaderChanges = (snapshot.countryCharts || [])
    .map((chart) => {
      const previousChart = previousCharts.get(chart.countryCode);
      const currentTrack = currentTracks.get(chart.entries?.[0]?.trackId);
      const previousTrack = previousTracks.get(previousChart?.entries?.[0]?.trackId);
      if (!currentTrack || !previousTrack) return null;
      if (normalizeTrackIdentity(currentTrack) === normalizeTrackIdentity(previousTrack)) return null;
      return {
        country: countries.get(chart.countryCode),
        currentTrack,
        previousTrack,
      };
    })
    .filter(Boolean);

  const currentGenres = loadGenreDiscoveryForDate(entry.date);
  const previousGenres = loadGenreDiscoveryForDate(previousEntry.date);
  const previousGenreById = new Map(
    (previousGenres?.signals || []).map((signal) => [signal.genre?.id, signal]),
  );
  const genreMovers = (currentGenres?.signals || [])
    .filter(genreSignalHasChartEvidence)
    .map((signal) => ({
      signal,
      previous: previousGenreById.get(signal.genre?.id),
    }))
    .filter((item) => item.previous && item.previous.rank > item.signal.rank)
    .sort((a, b) =>
      b.previous.rank - b.signal.rank - (a.previous.rank - a.signal.rank),
    )
    .slice(0, 4);

  const moverItems = movers
    .map(
      ({ track, previous, delta }) =>
        `<li><strong>${escapeHtml(track.title)}</strong> by ${escapeHtml(track.artist)} rose ${formatArticleNumber(delta)} places, from #${formatArticleNumber(previous.rank)} to #${formatArticleNumber(track.rank)}, and appears in ${formatArticleNumber(track.appearances)} markets.</li>`,
    )
    .join('\n');
  const newEntrantItems = newEntrants
    .map(
      (track) =>
        `<li><strong>${escapeHtml(track.title)}</strong> by ${escapeHtml(track.artist)} entered the stored aggregate at #${formatArticleNumber(track.rank)}, with ${formatArticleNumber(track.appearances)} market appearances and ${formatArticleNumber(track.topTens)} Top 10 placements.</li>`,
    )
    .join('\n');
  const countryChangeItems = countryLeaderChanges
    .slice(0, 8)
    .map(
      ({ country, currentTrack, previousTrack }) =>
        `<li><strong>${escapeHtml(country?.name || 'Unknown market')}:</strong> ${escapeHtml(currentTrack.title)} by ${escapeHtml(currentTrack.artist)} replaced ${escapeHtml(previousTrack.title)} by ${escapeHtml(previousTrack.artist)}.</li>`,
    )
    .join('\n');
  const genreMoverItems = genreMovers
    .map(
      ({ signal, previous }) =>
        `<li><strong>${escapeHtml(signal.genre.name)}</strong> moved from #${formatArticleNumber(previous.rank)} to #${formatArticleNumber(signal.rank)}, supported by ${formatArticleNumber(genreMatchedTrackCount(signal))} matched chart songs.</li>`,
    )
    .join('\n');
  const expanderText = marketExpanders.length
    ? marketExpanders
        .map(
          ({ track, previous }) =>
            `${escapeHtml(track.title)} (${formatArticleNumber(previous.appearances)} to ${formatArticleNumber(track.appearances)} markets)`,
        )
        .join('; ')
    : 'No Top 100 song expanded into at least two additional tracked markets this week.';

  const leaderPreviousText = leaderPrevious
    ? `moved from #${formatArticleNumber(leaderPrevious.rank)} to #${formatArticleNumber(leader.rank)}`
    : 'was not present in the previous stored aggregate';
  const previousLeaderCurrentText = previousLeaderCurrent
    ? `now ranks #${formatArticleNumber(previousLeaderCurrent.rank)}`
    : 'is outside the current stored aggregate';

  return `
    <section aria-labelledby="week-over-week-analysis">
      <h2 id="week-over-week-analysis">What changed since ${escapeHtml(previousEntry.date)}</h2>
      <p>The comparison below uses identical country coverage and the stored aggregate scoring model. It focuses on changes that are visible across markets rather than treating a one-country spike as a global trend.</p>
      <h3>Aggregate leadership</h3>
      <p><strong>${escapeHtml(leader?.title || 'No leader')}</strong> by ${escapeHtml(leader?.artist || 'unknown artist')} ${leaderPreviousText}. It appears in ${formatArticleNumber(leader?.appearances)} markets, including ${formatArticleNumber(leader?.topTens)} Top 10 placements. Last week's leader, <strong>${escapeHtml(previousLeader?.title || 'No previous leader')}</strong> by ${escapeHtml(previousLeader?.artist || 'unknown artist')}, ${previousLeaderCurrentText}.</p>
      <h3>Fastest aggregate movers</h3>
      ${moverItems ? `<ul>${moverItems}</ul>` : '<p>No returning track climbed at least 10 aggregate positions inside this week\'s Top 100.</p>'}
      <p><strong>Market expansion:</strong> ${expanderText}</p>
      <h3>Newly visible in the Top 100</h3>
      ${newEntrantItems ? `<ul>${newEntrantItems}</ul>` : '<p>Every current Top 100 track was already present in the previous stored snapshot.</p>'}
      <h3>Country #1 turnover</h3>
      <p>${formatArticleNumber(countryLeaderChanges.length)} of ${formatArticleNumber(snapshot.countries.length)} tracked countries changed their #1 song after normalizing title and artist punctuation.</p>
      ${countryChangeItems ? `<ul>${countryChangeItems}</ul>` : ''}
      <h3>Genre movement with track evidence</h3>
      ${genreMoverItems ? `<ul>${genreMoverItems}</ul>` : '<p>No evidence-backed genre improved its relative rank against the previous snapshot.</p>'}
      <p class="note">Movement here is a comparison between two stored weekly snapshots. It describes what changed in the data; release schedules, holidays, social trends, touring, and platform behavior are possible explanations only when independently verified.</p>
    </section>
  `;
}

function weeklyReportPage(date) {
  const entry = resolveSnapshotEntry(date);
  const snapshot = loadSnapshotFromEntry(entry);
  const analysis = loadAnalysisFromEntry(entry);
  if (!entry || !snapshot || !analysis) {
    return null;
  }

  const trackRows = (analysis.trackStats || [])
    .slice(0, 20)
    .map((track) => `<tr><td>#${track.rank}</td><td>${escapeHtml(track.title)}</td><td>${escapeHtml(track.artist)}</td><td>${formatArticleNumber(track.appearances)}</td><td>${formatArticleNumber(track.topTens)}</td><td>#${formatArticleNumber(track.bestRank)}</td></tr>`)
    .join('\n');
  const artistRows = (analysis.artistStats || [])
    .slice(0, 15)
    .map((artist) => `<tr><td>#${artist.rank}</td><td>${escapeHtml(artist.artist)}</td><td>${formatArticleNumber(artist.appearances)}</td><td>${formatArticleNumber(artist.topTens)}</td><td>${formatArticleNumber(Math.round(artist.weightedScore || 0))}</td></tr>`)
    .join('\n');
  const trackById = trackByIdMap(snapshot);
  const countryByCode = countryByCodeMap(snapshot);
  const numberOneRows = (snapshot.countryCharts || [])
    .map((chart) => {
      const country = countryByCode.get(chart.countryCode);
      const entry = chart.entries?.[0];
      const track = entry ? trackById.get(entry.trackId) : null;
      if (!country || !entry || !track) return '';
      return `<tr><td>${escapeHtml(country.name)}</td><td>${escapeHtml(country.region)}</td><td>${escapeHtml(track.title)}</td><td>${escapeHtml(track.artist)}</td><td>${formatArticleNumber(entry.streams)} streams</td></tr>`;
    })
    .join('\n');
  const leader = analysis.trackStats?.[0];
  const topArtist = analysis.artistStats?.[0];
  const editorialNote = loadWeeklyEditorialNote(entry.date);
  const editorialSection = weeklyEditorialNoteSection(editorialNote);
  const comparisonSection = weeklyComparisonSection(entry, snapshot, analysis);

  return articlePage({
    title: `Weekly global music chart report: ${entry.date}`,
    description: `Chart Atlas weekly report for ${entry.date}, covering ${snapshot.countries.length} countries and ${snapshot.tracks.length} charting tracks.`,
    canonicalPath: `/weekly/${entry.date}`,
    eyebrow: 'Weekly chart report',
    body: `
      <h1>Weekly global music chart report: ${escapeHtml(entry.date)}</h1>
      <p class="lede">This report summarizes the Chart Atlas snapshot for ${escapeHtml(entry.date)}. It compares country chart positions across ${formatArticleNumber(snapshot.countries.length)} markets and ranks songs by cross-country visibility, top-10 strength, and best local rank.</p>
      <div class="meta"><span>Source: ${escapeHtml(snapshot.sourceName || entry.sourceName)}</span><span>Generated: ${escapeHtml(formatArticleDate(snapshot.generatedAt || entry.generatedAt))}</span><span>${formatArticleNumber(snapshot.tracks.length)} unique tracks</span></div>
      <div class="grid">
        <div class="card"><strong>${escapeHtml(leader?.title || 'No leader')}</strong><small>Top cross-country song by ${escapeHtml(leader?.artist || 'unknown artist')}</small></div>
        <div class="card"><strong>${escapeHtml(topArtist?.artist || 'No artist leader')}</strong><small>Top artist by aggregate chart score</small></div>
      </div>
      ${editorialSection}
      ${comparisonSection}
      <p>The table is not a single-country stream chart. A song can lead the weekly report by appearing repeatedly across markets, by ranking highly in several countries, or by combining many mid-chart placements with a few top-10 results.</p>
      <h2>Top cross-country songs</h2>
      <table><thead><tr><th>Rank</th><th>Song</th><th>Artist</th><th>Countries</th><th>Top 10s</th><th>Best rank</th></tr></thead><tbody>${trackRows}</tbody></table>
      <h2>Top artists</h2>
      <table><thead><tr><th>Rank</th><th>Artist</th><th>Appearances</th><th>Top 10s</th><th>Score</th></tr></thead><tbody>${artistRows}</tbody></table>
      <h2>Country #1 songs</h2>
      <table><thead><tr><th>Country</th><th>Region</th><th>#1 song</th><th>Artist</th><th>Streams</th></tr></thead><tbody>${numberOneRows}</tbody></table>
      <p class="note">Interpretation: Chart Atlas is designed for discovery rather than official certification. It favors comparative signal: where a song appears, how high it appears, and whether that pattern crosses regional boundaries.</p>
    `,
  });
}

function countryReportPage(code) {
  const normalizedCode = String(code || '').toUpperCase();
  const entry = resolveSnapshotEntry();
  const snapshot = loadSnapshotFromEntry(entry);
  const previousEntry = previousSnapshotEntry(entry?.date);
  const previousSnapshot = loadSnapshotFromEntry(previousEntry);
  if (!entry || !snapshot) {
    return null;
  }

  const country = countryByCodeMap(snapshot).get(normalizedCode);
  const chart = chartForCountry(snapshot, normalizedCode);
  if (!country || !chart) {
    return null;
  }

  const trackById = trackByIdMap(snapshot);
  const previousChart = chartForCountry(previousSnapshot, normalizedCode);
  const topTen = (chart.entries || []).slice(0, 10).map((chartEntry) => ({
    entry: chartEntry,
    track: trackById.get(chartEntry.trackId),
    movement: entryMovement(chartEntry, previousChart),
  }));
  const rows = topTen
    .filter((item) => item.track)
    .map((item) => `<tr><td>#${item.entry.rank}</td><td>${escapeHtml(item.track.title)}</td><td>${escapeHtml(item.track.artist)}</td><td>${escapeHtml(item.movement.label)}</td><td>${formatArticleNumber(item.entry.streams)} streams</td></tr>`)
    .join('\n');
  const numberOne = topTen[0];
  const newCount = topTen.filter((item) => item.movement.label === 'new this week').length;
  const risingCount = topTen.filter((item) => item.movement.label.startsWith('up ')).length;
  const totalStreams = topTen.reduce((sum, item) => sum + Number(item.entry.streams || 0), 0);

  const analysis = loadAnalysisFromEntry(entry);
  const aggregateByTrackId = aggregateTrackStatsMap(analysis);
  const totalCountries = (snapshot.countries || []).length;
  const allEntries = chart.entries || [];

  const localFavorites = topTen
    .filter((item) => item.track)
    .map((item) => ({ ...item, stat: aggregateByTrackId.get(item.entry.trackId) }))
    .filter((item) => item.stat && item.stat.appearances <= 3)
    .slice(0, 3);
  const localTrackIds = new Set(allEntries.map((chartEntry) => chartEntry.trackId));
  const missingGlobalHits = (analysis?.trackStats || [])
    .slice(0, 15)
    .filter((stat) => !localTrackIds.has(stat.trackId));
  const exclusives = allEntries
    .map((chartEntry) => ({
      chartEntry,
      stat: aggregateByTrackId.get(chartEntry.trackId),
      track: trackById.get(chartEntry.trackId),
    }))
    .filter((item) => item.track && item.stat && item.stat.appearances === 1);

  const history = loadSnapshotHistory();
  const numberOneId = numberOne?.entry?.trackId || '';
  let numberOneTenure = 0;
  for (const item of history) {
    const localLeader = chartForCountry(item.snapshot, normalizedCode)?.entries?.[0];
    if (!localLeader || !numberOneId || localLeader.trackId !== numberOneId) break;
    numberOneTenure += 1;
  }
  const topTenPresenceWeeks = new Map();
  for (const item of history) {
    const weekTopTenIds = new Set(
      (chartForCountry(item.snapshot, normalizedCode)?.entries || [])
        .slice(0, 10)
        .map((chartEntry) => chartEntry.trackId),
    );
    for (const local of topTen) {
      if (local.track && weekTopTenIds.has(local.entry.trackId)) {
        topTenPresenceWeeks.set(
          local.entry.trackId,
          (topTenPresenceWeeks.get(local.entry.trackId) || 0) + 1,
        );
      }
    }
  }
  const longestRunning = topTen
    .filter((item) => item.track)
    .map((item) => ({ ...item, weeks: topTenPresenceWeeks.get(item.entry.trackId) || 0 }))
    .sort((a, b) => b.weeks - a.weeks)[0] || null;

  const churnHere = countryChartChurn(snapshot, previousSnapshot, normalizedCode);
  const churnValues = (snapshot.countries || [])
    .map((item) => countryChartChurn(snapshot, previousSnapshot, item.code))
    .filter((value) => value !== null);
  const averageChurn = churnValues.length
    ? churnValues.reduce((sum, value) => sum + value, 0) / churnValues.length
    : null;

  const describeSong = (title, artist) => `<strong>${escapeHtml(title)}</strong> by ${escapeHtml(artist)}`;

  const localFavoriteText = localFavorites.length
    ? `The clearest local signals this week: ${localFavorites
        .map(
          (item) =>
            `${describeSong(item.track.title, item.track.artist)} (local #${item.entry.rank}, on ${formatArticleNumber(item.stat.appearances)} of ${formatArticleNumber(totalCountries)} tracked charts)`,
        )
        .join('; ')}. Songs like these hold Top 10 positions in ${escapeHtml(country.name)} while staying nearly invisible in the cross-country aggregate — usually a sign of language-market momentum or a domestic release cycle rather than a global push.`
    : `Every current ${escapeHtml(country.name)} Top 10 song also appears on at least three other tracked country charts this week, so the local list mostly mirrors cross-market consensus rather than a domestic-only cycle.`;

  const missingHitsText = missingGlobalHits.length
    ? `Working in the other direction, ${formatArticleNumber(missingGlobalHits.length)} of the current global aggregate Top 15 songs do not chart in ${escapeHtml(country.name)} at all this week, including ${missingGlobalHits
        .slice(0, 3)
        .map((stat) => describeSong(stat.title, stat.artist))
        .join(', ')}. When a cross-market hit skips a market entirely, the gap usually maps to language, genre preference, or a local release calendar.`
    : `Every song in the current global aggregate Top 15 also appears somewhere in the ${escapeHtml(country.name)} chart — an unusually high overlap with the cross-market consensus.`;

  const exclusivesText = exclusives.length
    ? `<p>${formatArticleNumber(exclusives.length)} of the ${formatArticleNumber(allEntries.length)} songs on the full ${escapeHtml(country.name)} chart appear nowhere else in the tracked set this week. The highest-ranked market exclusives: ${exclusives
        .slice(0, 3)
        .map((item) => `${describeSong(item.track.title, item.track.artist)} at local #${item.chartEntry.rank}`)
        .join('; ')}.</p>`
    : '';

  const previousTrackById = trackByIdMap(previousSnapshot);
  const previousLeaderEntry = previousChart?.entries?.[0];
  const previousLeaderTrack = previousLeaderEntry
    ? previousTrackById.get(previousLeaderEntry.trackId)
    : null;
  let tenureText = '';
  if (numberOne?.track && numberOneTenure >= 2) {
    tenureText = `${describeSong(numberOne.track.title, numberOne.track.artist)} has now led the ${escapeHtml(country.name)} chart for ${formatArticleNumber(numberOneTenure)} consecutive stored weeks.`;
  } else if (numberOne?.track && previousLeaderTrack && previousLeaderEntry.trackId !== numberOneId) {
    tenureText = `${describeSong(numberOne.track.title, numberOne.track.artist)} is a new local #1, replacing ${describeSong(previousLeaderTrack.title, previousLeaderTrack.artist)} from the previous stored week.`;
  } else if (numberOne?.track) {
    tenureText = `${describeSong(numberOne.track.title, numberOne.track.artist)} leads the current ${escapeHtml(country.name)} chart.`;
  }
  const longevityText =
    longestRunning && longestRunning.weeks >= 2
      ? `The longest-running current Top 10 song is ${describeSong(longestRunning.track.title, longestRunning.track.artist)}, present in the local Top 10 for ${formatArticleNumber(longestRunning.weeks)} of the last ${formatArticleNumber(history.length)} stored weeks.`
      : `No current Top 10 song carries more than one stored week of local Top 10 tenure, which marks this as a fully refreshed local list.`;

  let churnText = '';
  if (churnHere !== null && averageChurn !== null) {
    const herePct = Math.round(churnHere * 100);
    const avgPct = Math.round(averageChurn * 100);
    const diff = churnHere - averageChurn;
    if (diff > 0.08) {
      churnText = `<p>${formatArticleNumber(herePct)}% of the full local chart is new versus the previous stored week, clearly above the ${formatArticleNumber(avgPct)}% average across all ${formatArticleNumber(totalCountries)} tracked countries. ${escapeHtml(country.name)} is one of the more volatile markets in this comparison window.</p>`;
    } else if (diff < -0.08) {
      churnText = `<p>Only ${formatArticleNumber(herePct)}% of the full local chart changed versus the previous stored week, below the ${formatArticleNumber(avgPct)}% average across all ${formatArticleNumber(totalCountries)} tracked countries. ${escapeHtml(country.name)} is currently one of the more stable markets in the set.</p>`;
    } else {
      churnText = `<p>${formatArticleNumber(herePct)}% of the full local chart is new versus the previous stored week, in line with the ${formatArticleNumber(avgPct)}% average across the tracked set — typical turnover for this comparison window.</p>`;
    }
  }

  return articlePage({
    title: `${country.name} music chart report`,
    description: `${country.name} music chart report for ${entry.date}: ${numberOne?.track?.title || 'the current #1'} by ${numberOne?.track?.artist || 'unknown artist'} leads the Top 10, with week-over-week movement, local-only songs, and global comparison.`,
    canonicalPath: `/countries/${country.code.toLowerCase()}`,
    eyebrow: 'Country chart report',
    body: `
      <h1>${escapeHtml(country.name)} music chart report</h1>
      <p class="lede">This country report reads the latest ${escapeHtml(country.name)} chart snapshot from Chart Atlas and compares the current Top 10 with the previous stored week. It is useful for spotting local breakouts, returning hits, and songs that are stronger in this market than globally.</p>
      <div class="meta"><span>Latest week: ${escapeHtml(entry.date)}</span><span>Region: ${escapeHtml(country.region)}</span><span>Previous comparison: ${escapeHtml(previousEntry?.date || 'none')}</span></div>
      <div class="grid">
        <div class="card"><strong>${escapeHtml(numberOne?.track?.title || 'No #1')}</strong><small>Current #1 by ${escapeHtml(numberOne?.track?.artist || 'unknown artist')}</small></div>
        <div class="card"><strong>${formatArticleNumber(totalStreams)}</strong><small>combined streams across this Top 10 sample</small></div>
        <div class="card"><strong>${formatArticleNumber(risingCount)}</strong><small>Top 10 songs moving up versus the previous snapshot</small></div>
        <div class="card"><strong>${formatArticleNumber(newCount)}</strong><small>Top 10 songs not seen in this country last snapshot</small></div>
      </div>
      <h2>${escapeHtml(country.name)} Top 10</h2>
      <table><thead><tr><th>Rank</th><th>Song</th><th>Artist</th><th>Movement</th><th>Streams</th></tr></thead><tbody>${rows}</tbody></table>
      <h2>Local signal versus the global table</h2>
      <p>${localFavoriteText}</p>
      <p>${missingHitsText}</p>
      ${exclusivesText}
      <h2>Stability and turnover</h2>
      <p>${tenureText} ${longevityText}</p>
      ${churnText}
      <h2>How to read this market</h2>
      <p>${escapeHtml(country.name)} belongs to the ${escapeHtml(country.region)} region in Chart Atlas. A song that rises here but remains flat globally can indicate a local event, language-market momentum, or a regional genre signal. A song that is simultaneously strong here and in several other countries is more likely to be part of a cross-market trend.</p>
      <p class="note">The movement labels compare stored weekly snapshots. They are not a claim about every daily chart change between the two capture dates.</p>
    `,
  });
}

function genreReportPage(genreId) {
  const entry = resolveSnapshotEntry();
  const genreData = entry ? loadGenreDiscoveryForDate(entry.date) : null;
  const signal = (genreData?.signals || []).find((item) => item.genre?.id === genreId);
  if (!entry || !genreData || !signal) {
    return null;
  }

  const matchedTracks = signal.matchedTracks || [];
  const countryCounts = matchedTracks.reduce((map, item) => {
    const country = item.country?.name || item.country?.code || 'Unknown';
    map.set(country, (map.get(country) || 0) + 1);
    return map;
  }, new Map());
  const topCountries = [...countryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const trackRows = matchedTracks
    .slice(0, 20)
    .map((item) => `<tr><td>#${formatArticleNumber(item.entry?.rank)}</td><td>${escapeHtml(item.track?.title || '')}</td><td>${escapeHtml(item.track?.artist || '')}</td><td>${escapeHtml(item.country?.name || '')}</td><td>${escapeHtml((item.reasons || []).slice(0, 2).join('; '))}</td></tr>`)
    .join('\n');
  const countryRows = topCountries
    .map(([country, count]) => `<tr><td>${escapeHtml(country)}</td><td>${formatArticleNumber(count)} matched chart songs</td></tr>`)
    .join('\n');
  const topTrack = matchedTracks[0];
  const hasChartEvidence = genreSignalHasChartEvidence(signal);
  const isIndexable = genreSignalIsIndexable(signal);

  const previousEntry = previousSnapshotEntry(entry.date);
  const previousGenreData = loadGenreDiscoveryForDateStrict(previousEntry?.date);
  const previousSignal = (previousGenreData?.signals || []).find(
    (item) => item.genre?.id === genreId,
  );
  let movementText = '';
  if (previousSignal) {
    const rankDelta = Number(previousSignal.rank) - Number(signal.rank);
    const matchedDelta = genreMatchedTrackCount(signal) - genreMatchedTrackCount(previousSignal);
    const matchedPhrase =
      matchedDelta === 0
        ? `an unchanged count of ${formatArticleNumber(genreMatchedTrackCount(signal))} matched chart songs`
        : `${formatArticleNumber(Math.abs(matchedDelta))} ${matchedDelta > 0 ? 'more' : 'fewer'} matched chart songs (${formatArticleNumber(genreMatchedTrackCount(previousSignal))} → ${formatArticleNumber(genreMatchedTrackCount(signal))})`;
    if (rankDelta > 0) {
      movementText = `<p>Versus the ${escapeHtml(previousEntry.date)} snapshot, ${escapeHtml(signal.genre.name)} climbed from genre rank #${formatArticleNumber(previousSignal.rank)} to #${formatArticleNumber(signal.rank)} with ${matchedPhrase}. A rank gain here means stronger relative representation among current charting songs, not a claim about total listening.</p>`;
    } else if (rankDelta < 0) {
      movementText = `<p>Versus the ${escapeHtml(previousEntry.date)} snapshot, ${escapeHtml(signal.genre.name)} slipped from genre rank #${formatArticleNumber(previousSignal.rank)} to #${formatArticleNumber(signal.rank)} with ${matchedPhrase}. Rank losses in this table track relative representation among matched chart songs.</p>`;
    } else {
      movementText = `<p>Versus the ${escapeHtml(previousEntry.date)} snapshot, ${escapeHtml(signal.genre.name)} held genre rank #${formatArticleNumber(signal.rank)} with ${matchedPhrase}.</p>`;
    }
  } else if (previousEntry) {
    movementText = `<p>The ${escapeHtml(previousEntry.date)} snapshot has no stored signal for this genre, so no week-over-week comparison is available yet.</p>`;
  }

  const totalMatched = matchedTracks.length;
  let concentrationText = '';
  if (totalMatched >= 3 && topCountries.length > 0) {
    const [topCountryName, topCountryCount] = topCountries[0];
    const topShare = topCountryCount / totalMatched;
    const namedSpread = topCountries
      .slice(0, 3)
      .map(([name, count]) => `${escapeHtml(name)} (${formatArticleNumber(count)})`)
      .join(', ');
    if (topShare >= 0.5) {
      concentrationText = `<p>The signal is heavily concentrated: ${escapeHtml(topCountryName)} alone contributes ${formatArticleNumber(Math.round(topShare * 100))}% of the ${formatArticleNumber(totalMatched)} matched songs. This reads as a domestic or language-market genre first, with limited cross-border chart presence this week.</p>`;
    } else if (topShare >= 0.3) {
      concentrationText = `<p>The signal leans on a small group of markets — ${namedSpread} lead the count of ${formatArticleNumber(totalMatched)} matched songs. The genre travels beyond one country, but its chart weight is still regionally anchored.</p>`;
    } else {
      concentrationText = `<p>The signal is broadly distributed across ${formatArticleNumber(countryCounts.size)} countries, led by ${namedSpread} out of ${formatArticleNumber(totalMatched)} matched songs. No single market dominates, which is the profile of a genuinely cross-market genre this week.</p>`;
    }
  }

  const artistCounts = new Map();
  for (const item of matchedTracks) {
    const artistName = String(item.track?.artist || '').trim();
    if (!artistName) continue;
    const record = artistCounts.get(artistName) || { count: 0, countries: new Set(), bestRank: Infinity };
    record.count += 1;
    if (item.country?.name) record.countries.add(item.country.name);
    const rank = Number(item.entry?.rank);
    if (Number.isFinite(rank)) record.bestRank = Math.min(record.bestRank, rank);
    artistCounts.set(artistName, record);
  }
  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].bestRank - b[1].bestRank)
    .slice(0, 8);
  const artistRows = topArtists
    .map(
      ([artistName, record]) =>
        `<tr><td>${escapeHtml(artistName)}</td><td>${formatArticleNumber(record.count)}</td><td>${escapeHtml([...record.countries].slice(0, 5).join(', '))}</td><td>${Number.isFinite(record.bestRank) ? `#${formatArticleNumber(record.bestRank)}` : '—'}</td></tr>`,
    )
    .join('\n');
  const artistSection =
    hasChartEvidence && topArtists.length > 0
      ? `
      <h2>Artists carrying the signal</h2>
      <table><thead><tr><th>Artist</th><th>Matched songs</th><th>Countries</th><th>Best local rank</th></tr></thead><tbody>${artistRows}</tbody></table>
    `
      : '';

  const evidenceBody = hasChartEvidence
    ? `
      <h2>Matched chart songs</h2>
      <table><thead><tr><th>Local rank</th><th>Song</th><th>Artist</th><th>Country</th><th>Evidence</th></tr></thead><tbody>${trackRows}</tbody></table>
      <h2>Countries contributing signal</h2>
      <table><thead><tr><th>Country</th><th>Matched count</th></tr></thead><tbody>${countryRows}</tbody></table>
    `
    : `
      <h2>No current chart evidence</h2>
      <p>This reference genre has no matched song and no positive chart score in the latest snapshot. It remains available for research continuity, but it is excluded from the public report index and search sitemap until chart-level evidence appears.</p>
    `;
  const indexingNote = !isIndexable
    ? `<p class="note">This page currently has ${formatArticleNumber(genreMatchedTrackCount(signal))} matched chart ${genreMatchedTrackCount(signal) === 1 ? 'song' : 'songs'}. Chart Atlas requires at least ${formatArticleNumber(MIN_INDEXABLE_GENRE_TRACKS)} matches before a genre report enters the search sitemap, so this reference page is marked noindex for now.</p>`
    : '';

  const editorial = genreEditorialEn(genreId);
  const summaryText =
    editorial?.summary ||
    signal.genre.summary ||
    `${signal.genre.name} is tracked as a Chart Atlas genre signal.`;
  const whyLocalText =
    editorial?.whyLocal ||
    signal.genre.whyLocal ||
    'The genre appears because current charting songs matched genre metadata, artist context, or track-level evidence.';

  return articlePage({
    title: `${signal.genre.name} genre signal report`,
    description: `${signal.genre.name} genre report from Chart Atlas for ${entry.date}, ranked #${signal.rank} with ${genreMatchedTrackCount(signal)} matched chart songs across country charts.`,
    canonicalPath: `/genres/${signal.genre.id}`,
    eyebrow: 'Genre signal report',
    robots: isIndexable ? 'index, follow' : 'noindex, follow',
    body: `
      <h1>${escapeHtml(signal.genre.name)} genre signal report</h1>
      <p class="lede">${escapeHtml(summaryText)} This page explains the latest chart evidence behind the genre ranking rather than treating the genre as a fixed country label.</p>
      <div class="meta"><span>Latest week: ${escapeHtml(entry.date)}</span><span>Genre rank: #${formatArticleNumber(signal.rank)}</span><span>Score: ${formatArticleNumber(Math.round(signal.chartPopularityScore || 0))}</span><span>Confidence: ${escapeHtml(signal.confidence || 'chart')}</span></div>
      <div class="grid">
        <div class="card"><strong>${formatArticleNumber(genreMatchedTrackCount(signal))}</strong><small>matched current chart songs</small></div>
        <div class="card"><strong>${escapeHtml(topTrack?.track?.title || 'No matched track')}</strong><small>highest-ranked matched example by ${escapeHtml(topTrack?.track?.artist || 'unknown artist')}</small></div>
      </div>
      <h2>Why this genre appears in the ranking</h2>
      <p>${escapeHtml(whyLocalText)}</p>
      ${movementText || concentrationText ? `<h2>Week-over-week movement and spread</h2>${movementText}${concentrationText}` : ''}
      ${evidenceBody}
      ${artistSection}
      ${indexingNote}
      <p class="note">Genre scores are generated from charting songs and their metadata evidence. A song can contribute to more than one genre when the available metadata supports multiple labels.</p>
    `,
  });
}

function buildDynamicSitemapXml() {
  const urls = [
    { loc: '/', changefreq: 'weekly', priority: '1.0' },
    { loc: '/weekly', changefreq: 'weekly', priority: '0.9' },
    { loc: '/countries', changefreq: 'weekly', priority: '0.8' },
    { loc: '/genres', changefreq: 'weekly', priority: '0.8' },
    { loc: '/about', changefreq: 'monthly', priority: '0.7' },
    { loc: '/privacy', changefreq: 'monthly', priority: '0.7' },
    { loc: '/contact', changefreq: 'monthly', priority: '0.7' },
    { loc: '/terms', changefreq: 'monthly', priority: '0.7' },
    { loc: '/methodology', changefreq: 'monthly', priority: '0.8' },
  ];
  const index = loadSnapshotIndex();
  const latestEntry = resolveSnapshotEntry();
  const latestSnapshot = loadSnapshotFromEntry(latestEntry);
  const latestGenres = latestEntry ? loadGenreDiscoveryForDate(latestEntry.date) : null;

  for (const entry of index.snapshots) {
    urls.push({ loc: `/weekly/${entry.date}`, changefreq: 'weekly', priority: '0.85' });
  }
  for (const country of latestSnapshot?.countries || []) {
    urls.push({ loc: `/countries/${country.code.toLowerCase()}`, changefreq: 'weekly', priority: '0.75' });
  }
  for (const signal of (latestGenres?.signals || []).filter(genreSignalIsIndexable)) {
    urls.push({ loc: `/genres/${signal.genre.id}`, changefreq: 'weekly', priority: signal.rank <= 15 ? '0.75' : '0.65' });
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(
      (url) => [
        '  <url>',
        `    <loc>https://foldalpha.com${escapeXml(url.loc)}</loc>`,
        `    <changefreq>${escapeXml(url.changefreq)}</changefreq>`,
        `    <priority>${escapeXml(url.priority)}</priority>`,
        '  </url>',
      ].join('\n'),
    ),
    '</urlset>',
  ].join('\n');
}

function handleReportRoute(req, res, routePath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  let html = null;
  if (routePath === '/weekly') {
    html = reportIndexPage();
  } else if (routePath === '/countries') {
    html = countriesIndexPage();
  } else if (routePath === '/genres') {
    html = genresIndexPage();
  } else {
    const weeklyMatch = routePath.match(/^\/weekly\/(\d{4}-\d{2}-\d{2})$/);
    const countryMatch = routePath.match(/^\/countries\/([a-z]{2})$/i);
    const genreMatch = routePath.match(/^\/genres\/([a-z0-9-]+)$/i);
    if (weeklyMatch) {
      html = weeklyReportPage(weeklyMatch[1]);
    } else if (countryMatch) {
      html = countryReportPage(countryMatch[1]);
    } else if (genreMatch) {
      html = genreReportPage(genreMatch[1]);
    } else {
      return false;
    }
  }

  if (!html) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  if (req.method === 'HEAD') {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (html.includes('content="noindex, follow"')) {
      headers['X-Robots-Tag'] = 'noindex, follow';
    }
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  const headers = html.includes('content="noindex, follow"')
    ? { 'X-Robots-Tag': 'noindex, follow' }
    : {};
  sendHtml(res, 200, html, headers);
  return true;
}

function sendFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (path.basename(filePath) === 'index.html') {
    const html = injectInitialData(injectCrawlerChartSummary(fs.readFileSync(filePath, 'utf8')));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  const headers = { 'Content-Type': contentTypes[extension] || 'application/octet-stream' };
  const distDataDir = `${path.resolve(distDir, 'data')}${path.sep}`;
  if (path.resolve(filePath).startsWith(distDataDir)) {
    headers['X-Robots-Tag'] = 'noindex';
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function resolveDistFile(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const candidatePath = path.join(distDir, normalizedPath);
  const resolvedPath = path.resolve(candidatePath);

  if (!resolvedPath.startsWith(path.resolve(distDir))) {
    return null;
  }

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    return resolvedPath;
  }

  const spaFallbackPath = `/${normalizedPath.replace(/^\/+|\/+$/g, '')}`;
  if (!SPA_FALLBACK_PATHS.has(spaFallbackPath === '/' ? '/' : spaFallbackPath)) {
    return null;
  }

  const indexPath = path.join(distDir, 'index.html');
  return fs.existsSync(indexPath) ? indexPath : null;
}

function resolvePublicFile(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const candidatePath = path.join(publicDir, normalizedPath);
  const resolvedPath = path.resolve(candidatePath);

  if (!resolvedPath.startsWith(path.resolve(publicDir))) {
    return null;
  }

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
    return resolvedPath;
  }

  return null;
}

async function handleCreatePlaylist(req, res) {
  if (!requirePlaylistWriteAccess(req, res, 'playlists.createFromTracks')) {
    return;
  }

  try {
    const body = await readJsonBody(req);
    const trackUris = normalizeTrackUris(body.trackUris);

    if (trackUris.length === 0) {
      sendJson(res, 400, { error: 'trackUris must contain Spotify track URIs.' });
      return;
    }

    const playlist = await createPlaylistFromTracks({
      name: String(body.name || '').trim() || 'Chart Atlas #1s',
      description: String(body.description || '').trim(),
      trackUris,
      isPublic: body.public !== false,
    });

    sendJson(res, 200, { playlist });
  } catch (error) {
    const message = formatApiError(error);
    console.error(`[api.playlists.createFromTracks] ${message}`);
    sendJson(res, 500, { error: message });
  }
}

async function handleCreateGenreDiscoveryPlaylist(req, res) {
  if (!requirePlaylistWriteAccess(req, res, 'genreDiscovery.createPlaylist')) {
    return;
  }

  try {
    const body = await readJsonBody(req);
    const seeds = normalizeGenreSeeds(body.seeds);
    const inputTrackUris = normalizeTrackUris(body.trackUris);

    if (seeds.length === 0 && inputTrackUris.length === 0) {
      sendJson(res, 400, { error: 'trackUris or seeds must be provided.' });
      return;
    }

    const found = [];
    const missed = [];
    const uriSet = new Set(inputTrackUris);

    for (const seed of seeds) {
      try {
        const match = await searchSpotifyTrack(seed);
        if (!match?.item?.uri) {
          missed.push(seed);
          continue;
        }

        if (uriSet.has(match.item.uri)) {
          missed.push({ ...seed, reason: 'duplicate_uri' });
          continue;
        }

        uriSet.add(match.item.uri);
        found.push({
          ...seed,
          uri: match.item.uri,
          matchedTrack: match.item.name,
          matchedArtists: (match.item.artists || []).map((artist) => artist.name).join(', '),
          score: match.score,
        });
      } catch (error) {
        missed.push({
          ...seed,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const seedTrackUris = found.map((item) => item.uri);
    const trackUris = [...inputTrackUris, ...seedTrackUris];
    if (trackUris.length === 0) {
      sendJson(res, 404, {
        error: '플레이리스트에 넣을 현재 차트 곡이나 매칭된 대표곡이 없습니다.',
        missed,
      });
      return;
    }

    const playlist = await createPlaylistFromTracks({
      name: String(body.name || '').trim() || 'Genre Atlas Local Discovery',
      description: String(body.description || '').trim(),
      trackUris,
      isPublic: body.public !== false,
    });

    sendJson(res, 200, {
      playlist,
      inputCount: inputTrackUris.length + seeds.length,
      chartTrackCount: inputTrackUris.length,
      matchedCount: inputTrackUris.length + found.length,
      seedMatchedCount: found.length,
      missedCount: missed.length,
      found,
      missed,
    });
  } catch (error) {
    const message = formatApiError(error);
    console.error(`[api.genreDiscovery.createPlaylist] ${message}`);
    sendJson(res, 500, { error: message });
  }
}

async function handleRisingArtistProfiles(req, res) {
  try {
    const body = await readJsonBody(req);
    const artists = normalizeRisingArtistSeeds(body.artists);

    if (artists.length === 0) {
      sendJson(res, 400, { error: 'artists must contain id and name.' });
      return;
    }

    const profiles = await fetchRisingArtistProfiles(artists);
    sendJson(res, 200, { profiles });
  } catch (error) {
    const message = formatApiError(error);
    console.error(`[api.rising.artistProfiles] ${message}`);
    sendJson(res, 500, { error: message });
  }
}

async function handleTasteTrackProfiles(req, res) {
  try {
    const body = await readJsonBody(req);
    const tracks = normalizeTasteTracks(body.tracks);

    if (tracks.length === 0) {
      sendJson(res, 400, { error: 'tracks must contain Spotify track IDs, titles, and artists.' });
      return;
    }

    const profiles = await fetchTasteTrackProfiles(tracks);
    sendJson(res, 200, { profiles });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api.taste.trackProfiles] ${message}`);
    sendJson(res, 500, { error: message });
  }
}

async function handleGenreArtistMetadata(req, res) {
  try {
    const body = await readJsonBody(req);
    const artistIds = normalizeSpotifyIds(body.artistIds);

    if (artistIds.length === 0) {
      sendJson(res, 400, { error: 'artistIds must contain Spotify artist IDs.' });
      return;
    }

    const artists = await fetchArtistMetadata(artistIds);
    sendJson(res, 200, { artists });
  } catch (error) {
    if (error?.statusCode === 403) {
      sendJson(res, 200, {
        artists: [],
        unavailable: true,
        warning: 'Spotify artist metadata is unavailable for this app/token.',
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api.genreDiscovery.artistMetadata] ${message}`);
    sendJson(res, 500, { error: message });
  }
}

async function handleGenreExternalMetadata(req, res) {
  try {
    const body = await readJsonBody(req);
    const artists = normalizeExternalArtists(body.artists);

    if (artists.length === 0) {
      sendJson(res, 400, { error: 'artists must contain id and name values.' });
      return;
    }

    const enrichedArtists = await fetchExternalArtistMetadata(artists);
    sendJson(res, 200, {
      artists: enrichedArtists,
      sources: ['MusicBrainz', 'Wikidata', 'Wikipedia'],
      limit: EXTERNAL_ARTIST_LOOKUP_LIMIT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api.genreDiscovery.externalMetadata] ${message}`);
    sendJson(res, 500, { error: message });
  }
}

async function handleGenreTrackMetadata(req, res) {
  try {
    const body = await readJsonBody(req);
    const tracks = normalizeExternalTracks(body.tracks);

    if (tracks.length === 0) {
      sendJson(res, 400, { error: 'tracks must contain id, title, and artist values.' });
      return;
    }

    const enrichedTracks = await fetchExternalTrackMetadata(tracks);
    sendJson(res, 200, {
      tracks: enrichedTracks,
      sources: ['Apple/iTunes'],
      limit: TRACK_METADATA_LOOKUP_LIMIT,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[api.genreDiscovery.trackMetadata] ${message}`);
    sendJson(res, 500, { error: message });
  }
}

function logPlaylistError(context, error, details = undefined) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${context}] ${message}`);
  if (details !== undefined) {
    console.error(`[${context}] details: ${JSON.stringify(details)}`);
  }
}

function handlePlaylistStudioRoute(req, res, routePath, requestUrl) {
  if (req.method === 'GET' && routePath === '/api/playlist-studio/playlists') {
    const force = requestUrl.searchParams.get('force') === 'true';
    fetchMyPublicPlaylists(force)
      .then((playlists) => {
        sendJson(res, 200, { playlists });
      })
      .catch((error) => {
        logPlaylistError('api.playlistStudio.playlists.list', error);
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (req.method === 'GET' && routePath === '/api/playlist-studio/chat/config') {
    const store = loadPlaylistSessionStore();
    sendJson(res, 200, {
      enabled: publicPlaylistWritesEnabled,
      repoUrl: playlistRepoUrl,
      activeTask: activePlaylistTask,
      currentSessionId: store.currentSessionId || '',
      sessions: listPlaylistSessionsForApi(store),
    });
    return true;
  }

  if (req.method === 'GET' && routePath === '/api/playlist-studio/chat/sessions') {
    const store = loadPlaylistSessionStore();
    sendJson(res, 200, {
      enabled: publicPlaylistWritesEnabled,
      repoUrl: playlistRepoUrl,
      activeTask: activePlaylistTask,
      currentSessionId: store.currentSessionId || '',
      sessions: listPlaylistSessionsForApi(store),
    });
    return true;
  }

  if (req.method === 'POST' && routePath === '/api/playlist-studio/chat/sessions/reset') {
    if (!requirePlaylistWriteAccess(req, res, 'playlistStudio.sessions.reset')) {
      return true;
    }

    if (activePlaylistTask) {
      sendJson(res, 409, { error: 'A Codex task is already running.' });
      return true;
    }

    const store = resetPlaylistSessionStore();
    sendJson(res, 200, {
      enabled: true,
      repoUrl: playlistRepoUrl,
      activeTask: false,
      currentSessionId: store.currentSessionId,
      sessions: listPlaylistSessionsForApi(store),
    });
    return true;
  }

  if (req.method === 'POST' && routePath === '/api/playlist-studio/chat/sessions') {
    if (!requirePlaylistWriteAccess(req, res, 'playlistStudio.sessions.create')) {
      return true;
    }

    if (activePlaylistTask) {
      sendJson(res, 409, { error: 'A Codex task is already running.' });
      return true;
    }

    activePlaylistTask = true;
    readJsonBody(req)
      .then(async (body) => {
        const resetSessions = body.reset !== false;
        const store = resetSessions ? resetPlaylistSessionStore() : loadPlaylistSessionStore();
        const now = new Date().toISOString();
        const title =
          String(body.title || '').trim() ||
          `Spotify Session ${new Date().toLocaleString('ko-KR', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })}`;

        const initPrompt = `${playlistRelayInstruction}\n\nReply with exactly: READY`;
        const result = await runCodex(buildCodexCreateCommand(initPrompt));
        if (!result.threadId) {
          throw new Error('Codex did not return a thread id.');
        }

        const session = {
          id: result.threadId,
          title,
          createdAt: now,
          updatedAt: now,
          history: [
            {
              role: 'assistant',
              content: '세션이 생성되었습니다. Spotify 플레이리스트 요청을 입력하세요.',
              at: now,
            },
          ],
        };

        store.sessions = resetSessions ? [session] : [session, ...(store.sessions || [])];
        store.currentSessionId = session.id;
        activePlaylistSessionId = session.id;
        savePlaylistSessionStore(store);

        sendJson(res, 200, {
          session: {
            id: session.id,
            title: session.title,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
          currentSessionId: store.currentSessionId,
          sessions: listPlaylistSessionsForApi(store),
        });
      })
      .catch((error) => {
        logPlaylistError('api.playlistStudio.chat.sessions.create', error);
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        activePlaylistTask = false;
      });
    return true;
  }

  if (req.method === 'POST' && routePath === '/api/playlist-studio/chat/sessions/select') {
    if (!requirePlaylistWriteAccess(req, res, 'playlistStudio.sessions.select')) {
      return true;
    }

    readJsonBody(req)
      .then((body) => {
        const sessionId = String(body.sessionId || '').trim();
        const store = loadPlaylistSessionStore();
        const found = (store.sessions || []).find((session) => session.id === sessionId);
        if (!found) {
          sendJson(res, 404, { error: 'Session not found.' });
          return;
        }

        store.currentSessionId = sessionId;
        activePlaylistSessionId = sessionId;
        savePlaylistSessionStore(store);
        sendJson(res, 200, {
          currentSessionId: store.currentSessionId,
          sessions: listPlaylistSessionsForApi(store),
        });
      })
      .catch((error) => {
        logPlaylistError('api.playlistStudio.chat.sessions.select', error);
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  }

  if (req.method === 'GET' && routePath === '/api/playlist-studio/chat/history') {
    const sessionId = requestUrl.searchParams.get('sessionId') || '';
    const store = loadPlaylistSessionStore();
    const session = (store.sessions || []).find((item) => item.id === sessionId) || null;
    sendJson(res, 200, {
      history: session?.history || [],
      activeTask: activePlaylistTask,
      enabled: publicPlaylistWritesEnabled,
      repoUrl: playlistRepoUrl,
    });
    return true;
  }

  if (req.method === 'POST' && routePath === '/api/playlist-studio/chat') {
    if (!requirePlaylistWriteAccess(req, res, 'playlistStudio.chat')) {
      return true;
    }

    if (activePlaylistTask) {
      sendJson(res, 409, {
        error: 'A Codex task is already running.',
      });
      return true;
    }

    activePlaylistTask = true;
    let parsedBody = {};
    readJsonBody(req)
      .then(async (body) => {
        parsedBody = body;
        const store = loadPlaylistSessionStore();
        const sessionId = String(body.sessionId || store.currentSessionId || '').trim();
        const session = (store.sessions || []).find((item) => item.id === sessionId);
        if (!session) {
          sendJson(res, 400, { error: '세션을 먼저 선택하거나 생성하세요.' });
          return;
        }

        const message = String(body.message || '').trim();
        if (!message) {
          sendJson(res, 400, { error: 'Message is required.' });
          return;
        }

        const userMessage = {
          role: 'user',
          content: message,
          at: new Date().toISOString(),
        };
        session.history.push(userMessage);
        session.updatedAt = userMessage.at;

        if (shouldBlockPlaylistMessage(message)) {
          const blockedMessage = {
            role: 'assistant',
            content:
              '이 채팅은 Spotify 플레이리스트 작업 전용입니다. 플레이리스트 추천, 생성, 정리, 설명 작성 같은 요청으로 보내주세요.',
            at: new Date().toISOString(),
          };
          session.history.push(blockedMessage);
          store.currentSessionId = session.id;
          savePlaylistSessionStore(store);
          sendJson(res, 400, {
            assistant: blockedMessage,
            activeTask: false,
            currentSessionId: store.currentSessionId,
            sessions: listPlaylistSessionsForApi(store),
          });
          return;
        }

        const result = await runCodex(
          buildCodexResumeCommand(session.id, buildPlaylistRelayPrompt(message)),
        );
        const assistantMessage = {
          role: 'assistant',
          content: result.reply,
          at: new Date().toISOString(),
        };
        session.history.push(assistantMessage);
        session.updatedAt = assistantMessage.at;
        store.currentSessionId = session.id;
        activePlaylistSessionId = session.id;
        savePlaylistSessionStore(store);
        playlistCache = { data: null, expiresAt: 0 };

        sendJson(res, 200, {
          assistant: assistantMessage,
          activeTask: false,
          currentSessionId: store.currentSessionId,
          sessions: listPlaylistSessionsForApi(store),
        });
      })
      .catch((error) => {
        const store = loadPlaylistSessionStore();
        const sessionId = String(parsedBody?.sessionId || store.currentSessionId || '').trim();
        const session = (store.sessions || []).find((item) => item.id === sessionId);
        const assistantMessage = {
          role: 'assistant',
          content: `오류: ${error instanceof Error ? error.message : String(error)}`,
          at: new Date().toISOString(),
        };
        if (session) {
          session.history.push(assistantMessage);
          session.updatedAt = assistantMessage.at;
          savePlaylistSessionStore(store);
        }

        logPlaylistError('api.playlistStudio.chat', error, parsedBody);
        sendJson(res, 500, {
          assistant: assistantMessage,
          activeTask: false,
          currentSessionId: store.currentSessionId || '',
          sessions: listPlaylistSessionsForApi(store),
        });
      })
      .finally(() => {
        activePlaylistTask = false;
      });
    return true;
  }

  return false;
}

async function startServer() {
  const vite = isProduction
    ? null
    : await import('vite').then(({ createServer }) =>
        createServer({
          appType: 'spa',
          server: { middlewareMode: true },
        }),
      );
  const port = Number(process.env.PORT || readCliValue('--port') || 5175);
  const host = process.env.HOST || readCliValue('--host') || '0.0.0.0';

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const routePath = stripAppBase(requestUrl.pathname);
    logAccessOnFinish(req, res, routePath, requestUrl);

    if (req.method === 'GET' && routePath === '/sitemap.xml') {
      sendXml(res, 200, buildDynamicSitemapXml());
      return;
    }

    if (handleInfoPageRoute(req, res, routePath)) {
      return;
    }

    if (handleReportRoute(req, res, routePath)) {
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/audit/event'
    ) {
      handleClientAuditEvent(req, res);
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/playlists/create-from-tracks'
    ) {
      handleCreatePlaylist(req, res);
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/genre-discovery/create-playlist'
    ) {
      handleCreateGenreDiscoveryPlaylist(req, res);
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/rising/artist-profiles'
    ) {
      handleRisingArtistProfiles(req, res);
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/taste/track-profiles'
    ) {
      handleTasteTrackProfiles(req, res);
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/genre-discovery/artist-metadata'
    ) {
      handleGenreArtistMetadata(req, res);
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/genre-discovery/external-metadata'
    ) {
      handleGenreExternalMetadata(req, res);
      return;
    }

    if (
      req.method === 'POST' &&
      routePath === '/api/genre-discovery/track-metadata'
    ) {
      handleGenreTrackMetadata(req, res);
      return;
    }

    if (handlePlaylistStudioRoute(req, res, routePath, requestUrl)) {
      return;
    }

    if (routePath.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    if (req.method === 'GET' && routePath.startsWith('/data/')) {
      const filePath = resolvePublicFile(routePath);
      if (!filePath) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      sendFile(res, filePath);
      return;
    }

    if (vite) {
      vite.middlewares(req, res, () => {
        sendJson(res, 404, { error: 'Not found' });
      });
      return;
    }

    const filePath = resolveDistFile(routePath);
    if (!filePath) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    sendFile(res, filePath);
  });

  server.listen(port, host, () => {
    ensurePlaylistSessionStore();
    console.log(`Chart Atlas running at http://${host}:${port}/`);
    console.log(`Playlist studio Codex extra args: ${codexExtraArgs.length ? codexExtraArgs.join(' ') : '(none)'}`);
  });
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
