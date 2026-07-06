export type Country = {
  code: string
  storefront: string
  mapId?: string
  name: string
  region: string
  marketWeight: number
  lon: number
  lat: number
}

export type Track = {
  id: string
  title: string
  artist: string
  artistId: string
  genre: string
  color: string
  url?: string
}

export type ChartEntry = {
  trackId: string
  rank: number
  change: number
  peak: number
  days: number
}

export type CountryChart = {
  countryCode: string
  entries: ChartEntry[]
}

export type ChartSnapshotData = {
  schemaVersion: 1
  sourceName: string
  sourceUrl?: string
  snapshotDate: string
  generatedAt?: string
  note?: string
  countries: Country[]
  tracks: Track[]
  countryCharts: CountryChart[]
}

export const snapshotDate = '2026-05-27'

export const countries: Country[] = [
  { code: 'US', storefront: 'us', mapId: '840', name: 'United States', region: 'North America', marketWeight: 1, lon: -98, lat: 39 },
  { code: 'CA', storefront: 'ca', mapId: '124', name: 'Canada', region: 'North America', marketWeight: 0.45, lon: -106, lat: 57 },
  { code: 'MX', storefront: 'mx', mapId: '484', name: 'Mexico', region: 'Latin America', marketWeight: 0.65, lon: -102, lat: 23 },
  { code: 'BR', storefront: 'br', mapId: '076', name: 'Brazil', region: 'Latin America', marketWeight: 0.75, lon: -52, lat: -10 },
  { code: 'AR', storefront: 'ar', mapId: '032', name: 'Argentina', region: 'Latin America', marketWeight: 0.38, lon: -64, lat: -34 },
  { code: 'CO', storefront: 'co', mapId: '170', name: 'Colombia', region: 'Latin America', marketWeight: 0.36, lon: -74, lat: 4 },
  { code: 'CL', storefront: 'cl', mapId: '152', name: 'Chile', region: 'Latin America', marketWeight: 0.28, lon: -71, lat: -30 },
  { code: 'PE', storefront: 'pe', mapId: '604', name: 'Peru', region: 'Latin America', marketWeight: 0.26, lon: -75, lat: -9 },
  { code: 'GB', storefront: 'gb', mapId: '826', name: 'United Kingdom', region: 'Europe', marketWeight: 0.7, lon: -2, lat: 54 },
  { code: 'FR', storefront: 'fr', mapId: '250', name: 'France', region: 'Europe', marketWeight: 0.6, lon: 2, lat: 46 },
  { code: 'DE', storefront: 'de', mapId: '276', name: 'Germany', region: 'Europe', marketWeight: 0.75, lon: 10, lat: 51 },
  { code: 'ES', storefront: 'es', mapId: '724', name: 'Spain', region: 'Europe', marketWeight: 0.48, lon: -4, lat: 40 },
  { code: 'IT', storefront: 'it', mapId: '380', name: 'Italy', region: 'Europe', marketWeight: 0.5, lon: 12, lat: 43 },
  { code: 'NL', storefront: 'nl', mapId: '528', name: 'Netherlands', region: 'Europe', marketWeight: 0.32, lon: 5, lat: 52 },
  { code: 'SE', storefront: 'se', mapId: '752', name: 'Sweden', region: 'Europe', marketWeight: 0.28, lon: 15, lat: 62 },
  { code: 'NO', storefront: 'no', mapId: '578', name: 'Norway', region: 'Europe', marketWeight: 0.22, lon: 8, lat: 61 },
  { code: 'FI', storefront: 'fi', mapId: '246', name: 'Finland', region: 'Europe', marketWeight: 0.2, lon: 26, lat: 64 },
  { code: 'PL', storefront: 'pl', mapId: '616', name: 'Poland', region: 'Europe', marketWeight: 0.34, lon: 19, lat: 52 },
  { code: 'TR', storefront: 'tr', mapId: '792', name: 'Turkey', region: 'MENA', marketWeight: 0.42, lon: 35, lat: 39 },
  { code: 'SA', storefront: 'sa', mapId: '682', name: 'Saudi Arabia', region: 'MENA', marketWeight: 0.32, lon: 45, lat: 24 },
  { code: 'AE', storefront: 'ae', mapId: '784', name: 'United Arab Emirates', region: 'MENA', marketWeight: 0.22, lon: 54, lat: 24 },
  { code: 'EG', storefront: 'eg', mapId: '818', name: 'Egypt', region: 'MENA', marketWeight: 0.36, lon: 30, lat: 27 },
  { code: 'NG', storefront: 'ng', mapId: '566', name: 'Nigeria', region: 'Africa', marketWeight: 0.42, lon: 8, lat: 9 },
  { code: 'ZA', storefront: 'za', mapId: '710', name: 'South Africa', region: 'Africa', marketWeight: 0.34, lon: 24, lat: -29 },
  { code: 'IN', storefront: 'in', mapId: '356', name: 'India', region: 'Asia', marketWeight: 0.9, lon: 78, lat: 22 },
  { code: 'ID', storefront: 'id', mapId: '360', name: 'Indonesia', region: 'Asia', marketWeight: 0.62, lon: 118, lat: -2 },
  { code: 'PH', storefront: 'ph', mapId: '608', name: 'Philippines', region: 'Asia', marketWeight: 0.38, lon: 122, lat: 13 },
  { code: 'TH', storefront: 'th', mapId: '764', name: 'Thailand', region: 'Asia', marketWeight: 0.36, lon: 101, lat: 15 },
  { code: 'VN', storefront: 'vn', mapId: '704', name: 'Vietnam', region: 'Asia', marketWeight: 0.34, lon: 106, lat: 16 },
  { code: 'MY', storefront: 'my', mapId: '458', name: 'Malaysia', region: 'Asia', marketWeight: 0.26, lon: 102, lat: 4 },
  { code: 'KR', storefront: 'kr', mapId: '410', name: 'South Korea', region: 'Asia', marketWeight: 0.55, lon: 128, lat: 36 },
  { code: 'JP', storefront: 'jp', mapId: '392', name: 'Japan', region: 'Asia', marketWeight: 0.8, lon: 138, lat: 37 },
  { code: 'AU', storefront: 'au', mapId: '036', name: 'Australia', region: 'Oceania', marketWeight: 0.42, lon: 134, lat: -25 },
  { code: 'NZ', storefront: 'nz', mapId: '554', name: 'New Zealand', region: 'Oceania', marketWeight: 0.16, lon: 172, lat: -41 },
  { code: 'SG', storefront: 'sg', name: 'Singapore', region: 'Asia', marketWeight: 0.18, lon: 104, lat: 1.35 },
]

export const tracks: Track[] = [
  { id: 'midnight-circuit', title: 'Midnight Circuit', artist: 'Mira Vale', artistId: 'mira-vale', genre: 'Electropop', color: '#2563eb' },
  { id: 'magnetic-sky', title: 'Magnetic Sky', artist: 'Nova Unit', artistId: 'nova-unit', genre: 'K-pop', color: '#d946ef' },
  { id: 'sol-de-rua', title: 'Sol de Rua', artist: 'Luan Cruz', artistId: 'luan-cruz', genre: 'Funk Pop', color: '#f59e0b' },
  { id: 'desert-call', title: 'Desert Call', artist: 'Hala Noor', artistId: 'hala-noor', genre: 'Arabic Pop', color: '#10b981' },
  { id: 'lagos-rush', title: 'Lagos Rush', artist: 'Kemi Ade', artistId: 'kemi-ade', genre: 'Afrobeats', color: '#ef4444' },
  { id: 'neon-sakura', title: 'Neon Sakura', artist: 'Yuki Arai', artistId: 'yuki-arai', genre: 'J-pop', color: '#ec4899' },
  { id: 'harbor-lights', title: 'Harbor Lights', artist: 'Sari Blue', artistId: 'sari-blue', genre: 'Indie Pop', color: '#14b8a6' },
  { id: 'after-hours-seoul', title: 'After Hours Seoul', artist: 'Nova Unit', artistId: 'nova-unit', genre: 'R&B Pop', color: '#7c3aed' },
  { id: 'raincheck', title: 'Raincheck', artist: 'Mira Vale', artistId: 'mira-vale', genre: 'Alt Pop', color: '#64748b' },
  { id: 'cumbia-norte', title: 'Cumbia Norte', artist: 'Rio Norte', artistId: 'rio-norte', genre: 'Latin Pop', color: '#84cc16' },
  { id: 'delhi-drive', title: 'Delhi Drive', artist: 'Asha Rao', artistId: 'asha-rao', genre: 'Hindi Pop', color: '#f97316' },
  { id: 'manila-glow', title: 'Manila Glow', artist: 'Luna Bayani', artistId: 'luna-bayani', genre: 'OPM Pop', color: '#06b6d4' },
  { id: 'anatolia-beat', title: 'Anatolia Beat', artist: 'Deniz Kaya', artistId: 'deniz-kaya', genre: 'Turkish Pop', color: '#22c55e' },
  { id: 'nordic-room', title: 'Nordic Room', artist: 'Freja North', artistId: 'freja-north', genre: 'Scandi Pop', color: '#38bdf8' },
  { id: 'velvet-metro', title: 'Velvet Metro', artist: 'The Left Bank', artistId: 'the-left-bank', genre: 'Dance Pop', color: '#8b5cf6' },
]

export const countryCharts: CountryChart[] = [
  { countryCode: 'US', entries: [{ trackId: 'midnight-circuit', rank: 1, change: 2, peak: 1, days: 18 }, { trackId: 'raincheck', rank: 2, change: 0, peak: 1, days: 42 }, { trackId: 'magnetic-sky', rank: 3, change: 4, peak: 3, days: 9 }, { trackId: 'lagos-rush', rank: 7, change: 3, peak: 7, days: 14 }, { trackId: 'sol-de-rua', rank: 11, change: 5, peak: 11, days: 6 }] },
  { countryCode: 'CA', entries: [{ trackId: 'midnight-circuit', rank: 1, change: 1, peak: 1, days: 17 }, { trackId: 'raincheck', rank: 3, change: -1, peak: 1, days: 38 }, { trackId: 'magnetic-sky', rank: 6, change: 2, peak: 6, days: 8 }, { trackId: 'lagos-rush', rank: 10, change: 4, peak: 10, days: 12 }, { trackId: 'harbor-lights', rank: 18, change: 1, peak: 15, days: 20 }] },
  { countryCode: 'MX', entries: [{ trackId: 'cumbia-norte', rank: 1, change: 3, peak: 1, days: 24 }, { trackId: 'sol-de-rua', rank: 2, change: 1, peak: 2, days: 15 }, { trackId: 'midnight-circuit', rank: 5, change: 2, peak: 5, days: 14 }, { trackId: 'magnetic-sky', rank: 11, change: 6, peak: 11, days: 5 }, { trackId: 'lagos-rush', rank: 16, change: 2, peak: 16, days: 9 }] },
  { countryCode: 'BR', entries: [{ trackId: 'sol-de-rua', rank: 1, change: 0, peak: 1, days: 31 }, { trackId: 'cumbia-norte', rank: 3, change: 1, peak: 3, days: 18 }, { trackId: 'lagos-rush', rank: 4, change: 5, peak: 4, days: 10 }, { trackId: 'midnight-circuit', rank: 9, change: 2, peak: 9, days: 11 }, { trackId: 'velvet-metro', rank: 20, change: -2, peak: 16, days: 25 }] },
  { countryCode: 'AR', entries: [{ trackId: 'cumbia-norte', rank: 1, change: 2, peak: 1, days: 16 }, { trackId: 'sol-de-rua', rank: 4, change: -1, peak: 2, days: 22 }, { trackId: 'midnight-circuit', rank: 8, change: 3, peak: 8, days: 12 }, { trackId: 'velvet-metro', rank: 14, change: 4, peak: 14, days: 7 }, { trackId: 'magnetic-sky', rank: 17, change: 2, peak: 17, days: 5 }] },
  { countryCode: 'CO', entries: [{ trackId: 'cumbia-norte', rank: 1, change: 1, peak: 1, days: 20 }, { trackId: 'sol-de-rua', rank: 3, change: 2, peak: 3, days: 13 }, { trackId: 'lagos-rush', rank: 9, change: 5, peak: 9, days: 8 }, { trackId: 'midnight-circuit', rank: 12, change: 1, peak: 12, days: 10 }, { trackId: 'desert-call', rank: 22, change: 2, peak: 22, days: 4 }] },
  { countryCode: 'CL', entries: [{ trackId: 'cumbia-norte', rank: 1, change: 4, peak: 1, days: 12 }, { trackId: 'sol-de-rua', rank: 5, change: 0, peak: 4, days: 19 }, { trackId: 'midnight-circuit', rank: 7, change: 2, peak: 7, days: 9 }, { trackId: 'velvet-metro', rank: 13, change: 1, peak: 13, days: 6 }, { trackId: 'magnetic-sky', rank: 19, change: 7, peak: 19, days: 3 }] },
  { countryCode: 'PE', entries: [{ trackId: 'cumbia-norte', rank: 1, change: 2, peak: 1, days: 14 }, { trackId: 'sol-de-rua', rank: 6, change: 1, peak: 5, days: 18 }, { trackId: 'lagos-rush', rank: 12, change: 2, peak: 12, days: 8 }, { trackId: 'midnight-circuit', rank: 16, change: 0, peak: 14, days: 12 }, { trackId: 'manila-glow', rank: 25, change: 4, peak: 25, days: 2 }] },
  { countryCode: 'GB', entries: [{ trackId: 'midnight-circuit', rank: 1, change: 1, peak: 1, days: 19 }, { trackId: 'raincheck', rank: 3, change: -1, peak: 1, days: 39 }, { trackId: 'lagos-rush', rank: 5, change: 3, peak: 5, days: 16 }, { trackId: 'harbor-lights', rank: 6, change: 4, peak: 6, days: 12 }, { trackId: 'magnetic-sky', rank: 9, change: 1, peak: 9, days: 9 }] },
  { countryCode: 'FR', entries: [{ trackId: 'velvet-metro', rank: 1, change: 2, peak: 1, days: 23 }, { trackId: 'midnight-circuit', rank: 2, change: 1, peak: 2, days: 14 }, { trackId: 'sol-de-rua', rank: 6, change: 4, peak: 6, days: 9 }, { trackId: 'desert-call', rank: 9, change: 5, peak: 9, days: 8 }, { trackId: 'magnetic-sky', rank: 11, change: 1, peak: 11, days: 7 }] },
  { countryCode: 'DE', entries: [{ trackId: 'midnight-circuit', rank: 1, change: 2, peak: 1, days: 15 }, { trackId: 'velvet-metro', rank: 3, change: 0, peak: 2, days: 21 }, { trackId: 'nordic-room', rank: 5, change: 4, peak: 5, days: 10 }, { trackId: 'desert-call', rank: 7, change: 3, peak: 7, days: 11 }, { trackId: 'magnetic-sky', rank: 12, change: 2, peak: 12, days: 7 }] },
  { countryCode: 'ES', entries: [{ trackId: 'cumbia-norte', rank: 1, change: 2, peak: 1, days: 17 }, { trackId: 'sol-de-rua', rank: 3, change: 1, peak: 3, days: 13 }, { trackId: 'velvet-metro', rank: 5, change: 3, peak: 5, days: 9 }, { trackId: 'midnight-circuit', rank: 8, change: 2, peak: 8, days: 10 }, { trackId: 'lagos-rush', rank: 15, change: 1, peak: 15, days: 6 }] },
  { countryCode: 'IT', entries: [{ trackId: 'velvet-metro', rank: 1, change: 1, peak: 1, days: 18 }, { trackId: 'midnight-circuit', rank: 4, change: 2, peak: 4, days: 11 }, { trackId: 'sol-de-rua', rank: 7, change: 3, peak: 7, days: 8 }, { trackId: 'desert-call', rank: 10, change: 5, peak: 10, days: 7 }, { trackId: 'magnetic-sky', rank: 16, change: 1, peak: 16, days: 6 }] },
  { countryCode: 'NL', entries: [{ trackId: 'midnight-circuit', rank: 1, change: 0, peak: 1, days: 13 }, { trackId: 'nordic-room', rank: 4, change: 5, peak: 4, days: 8 }, { trackId: 'velvet-metro', rank: 6, change: -1, peak: 3, days: 19 }, { trackId: 'raincheck', rank: 9, change: 2, peak: 9, days: 11 }, { trackId: 'lagos-rush', rank: 14, change: 3, peak: 14, days: 5 }] },
  { countryCode: 'SE', entries: [{ trackId: 'nordic-room', rank: 1, change: 3, peak: 1, days: 11 }, { trackId: 'midnight-circuit', rank: 3, change: 1, peak: 3, days: 13 }, { trackId: 'raincheck', rank: 6, change: 0, peak: 5, days: 20 }, { trackId: 'velvet-metro', rank: 8, change: 2, peak: 8, days: 9 }, { trackId: 'magnetic-sky', rank: 15, change: 3, peak: 15, days: 5 }] },
  { countryCode: 'NO', entries: [{ trackId: 'nordic-room', rank: 1, change: 2, peak: 1, days: 10 }, { trackId: 'midnight-circuit', rank: 4, change: 0, peak: 3, days: 15 }, { trackId: 'raincheck', rank: 7, change: 1, peak: 6, days: 18 }, { trackId: 'velvet-metro', rank: 11, change: 2, peak: 11, days: 6 }, { trackId: 'lagos-rush', rank: 19, change: 4, peak: 19, days: 3 }] },
  { countryCode: 'FI', entries: [{ trackId: 'nordic-room', rank: 1, change: 4, peak: 1, days: 9 }, { trackId: 'midnight-circuit', rank: 5, change: 1, peak: 5, days: 12 }, { trackId: 'velvet-metro', rank: 9, change: 2, peak: 9, days: 6 }, { trackId: 'raincheck', rank: 12, change: 0, peak: 10, days: 16 }, { trackId: 'magnetic-sky', rank: 18, change: 3, peak: 18, days: 4 }] },
  { countryCode: 'PL', entries: [{ trackId: 'midnight-circuit', rank: 1, change: 3, peak: 1, days: 8 }, { trackId: 'velvet-metro', rank: 4, change: 1, peak: 4, days: 12 }, { trackId: 'nordic-room', rank: 8, change: 5, peak: 8, days: 5 }, { trackId: 'desert-call', rank: 13, change: 4, peak: 13, days: 4 }, { trackId: 'magnetic-sky', rank: 21, change: 1, peak: 21, days: 3 }] },
  { countryCode: 'TR', entries: [{ trackId: 'anatolia-beat', rank: 1, change: 2, peak: 1, days: 20 }, { trackId: 'desert-call', rank: 3, change: 1, peak: 3, days: 13 }, { trackId: 'midnight-circuit', rank: 9, change: 2, peak: 9, days: 8 }, { trackId: 'velvet-metro', rank: 12, change: 3, peak: 12, days: 6 }, { trackId: 'magnetic-sky', rank: 20, change: 5, peak: 20, days: 3 }] },
  { countryCode: 'SA', entries: [{ trackId: 'desert-call', rank: 1, change: 1, peak: 1, days: 28 }, { trackId: 'anatolia-beat', rank: 4, change: 3, peak: 4, days: 10 }, { trackId: 'midnight-circuit', rank: 8, change: 1, peak: 8, days: 8 }, { trackId: 'magnetic-sky', rank: 13, change: 5, peak: 13, days: 5 }, { trackId: 'lagos-rush', rank: 19, change: 3, peak: 19, days: 4 }] },
  { countryCode: 'AE', entries: [{ trackId: 'desert-call', rank: 1, change: 0, peak: 1, days: 25 }, { trackId: 'midnight-circuit', rank: 5, change: 2, peak: 5, days: 11 }, { trackId: 'anatolia-beat', rank: 6, change: 1, peak: 6, days: 9 }, { trackId: 'magnetic-sky', rank: 10, change: 5, peak: 10, days: 5 }, { trackId: 'delhi-drive', rank: 16, change: 2, peak: 16, days: 6 }] },
  { countryCode: 'EG', entries: [{ trackId: 'desert-call', rank: 1, change: 2, peak: 1, days: 21 }, { trackId: 'anatolia-beat', rank: 5, change: 2, peak: 5, days: 8 }, { trackId: 'lagos-rush', rank: 8, change: 4, peak: 8, days: 7 }, { trackId: 'midnight-circuit', rank: 14, change: 1, peak: 14, days: 5 }, { trackId: 'sol-de-rua', rank: 24, change: 3, peak: 24, days: 2 }] },
  { countryCode: 'NG', entries: [{ trackId: 'lagos-rush', rank: 1, change: 0, peak: 1, days: 33 }, { trackId: 'desert-call', rank: 6, change: 2, peak: 6, days: 12 }, { trackId: 'sol-de-rua', rank: 9, change: 3, peak: 9, days: 8 }, { trackId: 'midnight-circuit', rank: 13, change: 1, peak: 13, days: 7 }, { trackId: 'cumbia-norte', rank: 21, change: 2, peak: 21, days: 3 }] },
  { countryCode: 'ZA', entries: [{ trackId: 'lagos-rush', rank: 1, change: 2, peak: 1, days: 19 }, { trackId: 'midnight-circuit', rank: 6, change: 1, peak: 6, days: 10 }, { trackId: 'desert-call', rank: 8, change: 4, peak: 8, days: 8 }, { trackId: 'raincheck', rank: 14, change: 2, peak: 14, days: 6 }, { trackId: 'sol-de-rua', rank: 17, change: 1, peak: 17, days: 5 }] },
  { countryCode: 'IN', entries: [{ trackId: 'delhi-drive', rank: 1, change: 1, peak: 1, days: 29 }, { trackId: 'magnetic-sky', rank: 4, change: 5, peak: 4, days: 8 }, { trackId: 'midnight-circuit', rank: 7, change: 2, peak: 7, days: 10 }, { trackId: 'desert-call', rank: 12, change: 4, peak: 12, days: 5 }, { trackId: 'manila-glow', rank: 18, change: 1, peak: 18, days: 4 }] },
  { countryCode: 'ID', entries: [{ trackId: 'harbor-lights', rank: 1, change: 4, peak: 1, days: 12 }, { trackId: 'magnetic-sky', rank: 3, change: 2, peak: 3, days: 13 }, { trackId: 'manila-glow', rank: 5, change: 6, peak: 5, days: 6 }, { trackId: 'midnight-circuit', rank: 9, change: 1, peak: 9, days: 8 }, { trackId: 'neon-sakura', rank: 15, change: 3, peak: 15, days: 4 }] },
  { countryCode: 'PH', entries: [{ trackId: 'manila-glow', rank: 1, change: 3, peak: 1, days: 15 }, { trackId: 'magnetic-sky', rank: 2, change: 1, peak: 2, days: 12 }, { trackId: 'harbor-lights', rank: 4, change: 2, peak: 4, days: 11 }, { trackId: 'midnight-circuit', rank: 11, change: 3, peak: 11, days: 7 }, { trackId: 'neon-sakura', rank: 18, change: 1, peak: 18, days: 4 }] },
  { countryCode: 'TH', entries: [{ trackId: 'magnetic-sky', rank: 1, change: 2, peak: 1, days: 10 }, { trackId: 'harbor-lights', rank: 3, change: 4, peak: 3, days: 8 }, { trackId: 'manila-glow', rank: 6, change: 3, peak: 6, days: 5 }, { trackId: 'midnight-circuit', rank: 10, change: 1, peak: 10, days: 8 }, { trackId: 'neon-sakura', rank: 12, change: 2, peak: 12, days: 6 }] },
  { countryCode: 'VN', entries: [{ trackId: 'harbor-lights', rank: 1, change: 2, peak: 1, days: 13 }, { trackId: 'magnetic-sky', rank: 3, change: 1, peak: 3, days: 11 }, { trackId: 'manila-glow', rank: 7, change: 5, peak: 7, days: 5 }, { trackId: 'midnight-circuit', rank: 12, change: 2, peak: 12, days: 6 }, { trackId: 'delhi-drive', rank: 19, change: 3, peak: 19, days: 3 }] },
  { countryCode: 'MY', entries: [{ trackId: 'magnetic-sky', rank: 1, change: 4, peak: 1, days: 9 }, { trackId: 'harbor-lights', rank: 2, change: 1, peak: 2, days: 12 }, { trackId: 'midnight-circuit', rank: 8, change: 2, peak: 8, days: 7 }, { trackId: 'manila-glow', rank: 9, change: 3, peak: 9, days: 5 }, { trackId: 'delhi-drive', rank: 16, change: 2, peak: 16, days: 4 }] },
  { countryCode: 'KR', entries: [{ trackId: 'magnetic-sky', rank: 1, change: 1, peak: 1, days: 22 }, { trackId: 'after-hours-seoul', rank: 2, change: 0, peak: 1, days: 35 }, { trackId: 'neon-sakura', rank: 4, change: 2, peak: 4, days: 10 }, { trackId: 'midnight-circuit', rank: 8, change: 5, peak: 8, days: 6 }, { trackId: 'harbor-lights', rank: 15, change: 4, peak: 15, days: 4 }] },
  { countryCode: 'JP', entries: [{ trackId: 'neon-sakura', rank: 1, change: 0, peak: 1, days: 26 }, { trackId: 'magnetic-sky', rank: 2, change: 1, peak: 2, days: 14 }, { trackId: 'after-hours-seoul', rank: 5, change: 2, peak: 5, days: 12 }, { trackId: 'midnight-circuit', rank: 9, change: 3, peak: 9, days: 7 }, { trackId: 'harbor-lights', rank: 17, change: 1, peak: 17, days: 4 }] },
  { countryCode: 'AU', entries: [{ trackId: 'midnight-circuit', rank: 1, change: 2, peak: 1, days: 16 }, { trackId: 'harbor-lights', rank: 4, change: 3, peak: 4, days: 10 }, { trackId: 'raincheck', rank: 6, change: -1, peak: 3, days: 21 }, { trackId: 'lagos-rush', rank: 9, change: 2, peak: 9, days: 8 }, { trackId: 'magnetic-sky', rank: 13, change: 4, peak: 13, days: 5 }] },
  { countryCode: 'NZ', entries: [{ trackId: 'harbor-lights', rank: 1, change: 2, peak: 1, days: 11 }, { trackId: 'midnight-circuit', rank: 2, change: 1, peak: 2, days: 13 }, { trackId: 'raincheck', rank: 5, change: 0, peak: 4, days: 19 }, { trackId: 'lagos-rush', rank: 12, change: 4, peak: 12, days: 5 }, { trackId: 'magnetic-sky', rank: 18, change: 2, peak: 18, days: 3 }] },
  { countryCode: 'SG', entries: [{ trackId: 'magnetic-sky', rank: 1, change: 2, peak: 1, days: 10 }, { trackId: 'harbor-lights', rank: 3, change: 1, peak: 3, days: 9 }, { trackId: 'midnight-circuit', rank: 6, change: 2, peak: 6, days: 8 }, { trackId: 'manila-glow', rank: 8, change: 4, peak: 8, days: 4 }, { trackId: 'delhi-drive', rank: 15, change: 3, peak: 15, days: 3 }] },
]

export const demoSnapshot: ChartSnapshotData = {
  schemaVersion: 1,
  sourceName: 'Demo snapshot',
  snapshotDate,
  countries,
  tracks,
  countryCharts,
}
