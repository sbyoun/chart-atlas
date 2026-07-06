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
const playlistRepoUrl = 'https://github.com/sbyoun/spotify-mcp-server';
let activePlaylistTask = false;
let activePlaylistSessionId = '';
let cachedSpotifyUserId = '';
let cachedSpotifyClientCredentials = { accessToken: '', expiresAt: 0 };
let playlistCache = { data: null, expiresAt: 0 };
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
const EXTERNAL_ARTIST_LOOKUP_LIMIT = readPositiveIntegerEnv('EXTERNAL_ARTIST_LOOKUP_LIMIT', 220);
const TRACK_METADATA_LOOKUP_LIMIT = readPositiveIntegerEnv('TRACK_METADATA_LOOKUP_LIMIT', 140);
const EXTERNAL_METADATA_USER_AGENT =
  process.env.EXTERNAL_METADATA_USER_AGENT || 'ChartAtlas/0.1 (local genre discovery)';

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
    .filter((playlist) => playlist?.owner?.id === userId && playlist.public === true)
    .map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description || '',
      tracksTotal: playlist.items?.total || playlist.tracks?.total || 0,
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

async function createPlaylistFromTracks({ name, description, trackUris, isPublic }) {
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

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function sendFile(res, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (path.basename(filePath) === 'index.html') {
    const html = injectCrawlerChartSummary(fs.readFileSync(filePath, 'utf8'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': contentTypes[extension] || 'application/octet-stream' });
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
      enabled: true,
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
      enabled: true,
      repoUrl: playlistRepoUrl,
      activeTask: activePlaylistTask,
      currentSessionId: store.currentSessionId || '',
      sessions: listPlaylistSessionsForApi(store),
    });
    return true;
  }

  if (req.method === 'POST' && routePath === '/api/playlist-studio/chat/sessions/reset') {
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
      enabled: true,
      repoUrl: playlistRepoUrl,
    });
    return true;
  }

  if (req.method === 'POST' && routePath === '/api/playlist-studio/chat') {
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
