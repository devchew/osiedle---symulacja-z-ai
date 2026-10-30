import type { WeatherSample, WeatherSource } from '../world/incidents';
import { tickToLocal } from './clock';

// Real weather from Open-Meteo (https://open-meteo.com — no key, CORS enabled)
// and the WMO weather-code mapping to the simulation's weather kinds.

export const DEFAULT_LOCATION = { lat: 52.23, lon: 21.01, name: 'Warszawa' } as const;

/**
 * WMO weather interpretation code (Open-Meteo `weather_code`) → simulation weather.
 * Snow and freezing precipitation count as 'rain' (keeps people indoors) with their own label; snow is flagged.
 * `cloudCover` (0..100) sets the intensity of cloudy weather when given.
 */
export function mapWmo(code: number, cloudCover?: number): WeatherSample {
  const cloudy = (fallback: number, label?: string, icon?: string): WeatherSample => ({
    kind: 'cloudy',
    intensity: cloudCover === undefined ? fallback : Math.max(0.2, Math.min(1, cloudCover / 100)),
    ...(label ? { label } : {}),
    ...(icon ? { icon } : {}),
  });
  const wet = (kind: 'rain' | 'storm', intensity: number, label: string, icon: string, snow = false): WeatherSample => ({
    kind,
    intensity,
    label,
    icon,
    ...(snow ? { snow } : {}),
  });
  switch (code) {
    case 0:
      return { kind: 'sunny', intensity: 0, label: 'Bezchmurnie' };
    case 1:
      return { kind: 'sunny', intensity: 0 };
    case 2:
      return cloudy(0.35, 'Częściowe zachmurzenie', '⛅');
    case 3:
      return cloudy(0.8);
    case 45:
    case 48:
      return cloudy(0.6, 'Mgła', '🌫️');
    case 51:
      return wet('rain', 0.25, 'Mżawka', '🌦️');
    case 53:
      return wet('rain', 0.35, 'Mżawka', '🌦️');
    case 55:
      return wet('rain', 0.45, 'Mżawka', '🌦️');
    case 56:
      return wet('rain', 0.35, 'Marznąca mżawka', '🌧️');
    case 57:
      return wet('rain', 0.5, 'Marznąca mżawka', '🌧️');
    case 61:
      return wet('rain', 0.45, 'Lekki deszcz', '🌧️');
    case 63:
      return wet('rain', 0.7, 'Deszcz', '🌧️');
    case 65:
      return wet('rain', 0.95, 'Ulewa', '🌧️');
    case 66:
      return wet('rain', 0.5, 'Marznący deszcz', '🌧️');
    case 67:
      return wet('rain', 0.85, 'Marznący deszcz', '🌧️');
    case 71:
      return wet('rain', 0.4, 'Lekki śnieg', '🌨️', true);
    case 73:
      return wet('rain', 0.6, 'Śnieg', '🌨️', true);
    case 75:
      return wet('rain', 0.85, 'Śnieżyca', '❄️', true);
    case 77:
      return wet('rain', 0.35, 'Ziarna śniegu', '🌨️', true);
    case 80:
      return wet('rain', 0.5, 'Przelotny deszcz', '🌦️');
    case 81:
      return wet('rain', 0.75, 'Przelotny deszcz', '🌦️');
    case 82:
      return wet('rain', 1, 'Gwałtowna ulewa', '🌧️');
    case 85:
      return wet('rain', 0.5, 'Przelotny śnieg', '🌨️', true);
    case 86:
      return wet('rain', 0.8, 'Przelotny śnieg', '🌨️', true);
    case 95:
      return wet('storm', 0.9, 'Burza', '⛈️');
    case 96:
    case 99:
      return wet('storm', 1, 'Burza z gradem', '⛈️');
    default:
      return cloudy(0.5);
  }
}

interface Reading {
  code: number;
  cloud?: number;
  temperature?: number;
}

/** parsed forecast: readings by local "YYYY-MM-DDTHH" plus the current (15-minute) reading */
export interface RealWeather {
  hourly: Map<string, Reading>;
  /** "YYYY-MM-DDTHH" of the current reading */
  currentHour: string | null;
  current: Reading | null;
}

/** parses an Open-Meteo forecast response (times in the requested local time zone) */
export function parseForecast(json: unknown): RealWeather {
  const j = json as {
    current?: { time?: string; weather_code?: number; cloud_cover?: number; temperature_2m?: number };
    hourly?: { time?: string[]; weather_code?: (number | null)[]; cloud_cover?: (number | null)[]; temperature_2m?: (number | null)[] };
  };
  const hourly = new Map<string, Reading>();
  const h = j.hourly;
  if (h?.time && h.weather_code) {
    h.time.forEach((t, i) => {
      const code = h.weather_code![i];
      const key = t.slice(0, 13);
      // fall-back DST days repeat an hour: keep the first one
      if (code === null || code === undefined || hourly.has(key)) return;
      hourly.set(key, { code, cloud: h.cloud_cover?.[i] ?? undefined, temperature: h.temperature_2m?.[i] ?? undefined });
    });
  }
  const c = j.current;
  const current =
    c && typeof c.weather_code === 'number' ? { code: c.weather_code, cloud: c.cloud_cover, temperature: c.temperature_2m } : null;
  return { hourly, current, currentHour: current && c?.time ? c.time.slice(0, 13) : null };
}

/** weather source for incidents' override: the reading for the tick's local hour (current reading for the current hour) */
export function weatherSource(data: () => RealWeather | null, baseDay: () => number): WeatherSource {
  return (tick) => {
    const d = data();
    if (!d) return null;
    const t = tickToLocal(tick, baseDay());
    const key = `${t.date}T${String(t.hour).padStart(2, '0')}`;
    const r = key === d.currentHour && d.current ? d.current : d.hourly.get(key);
    return r ? mapWmo(r.code, r.cloud) : null;
  };
}

function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'auto';
  } catch {
    return 'auto';
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * yesterday … tomorrow, hourly, in the browser's time zone (= the game clock) or `tz`
 * (the server's live worlds pass Europe/Warsaw), so hourly keys line up with tickToLocal
 */
export async function fetchRealWeather(lat: number, lon: number, timeoutMs = 6000, tz: string = timeZone()): Promise<RealWeather> {
  const vars = 'weather_code,precipitation,cloud_cover,temperature_2m';
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
    `&current=${vars}&hourly=${vars}&past_days=1&forecast_days=2&timezone=${encodeURIComponent(tz)}`;
  return parseForecast(await fetchJson(url, timeoutMs));
}

/**
 * place name (Polish) via BigDataCloud's keyless, CORS-enabled client-side reverse geocoding;
 * null on any failure
 */
export async function reverseGeocode(lat: number, lon: number, timeoutMs = 5000): Promise<string | null> {
  try {
    const j = (await fetchJson(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=pl`,
      timeoutMs,
    )) as { city?: string; locality?: string };
    return j.city || j.locality || null;
  } catch {
    return null;
  }
}
