/**
 * TradingView-style candle presets (colors, borders, wicks).
 * Bodies use transparency where noted to approximate hollow / outline looks (LW has no native hollow flag).
 */

export const CANDLE_THEME_STORAGE_KEY = 'qt_chart_candle_theme';

/** @typedef {{ id: string, label: string, candle: Record<string, unknown>, volumeUp: string, volumeDown: string }} CandleTheme */

/** @type {CandleTheme[]} */
export const CANDLE_THEMES = [
  {
    id: 'quantum',
    label: 'Quantum',
    candle: {
      upColor: '#00e676',
      downColor: '#ff1744',
      borderUpColor: '#00e676',
      borderDownColor: '#ff1744',
      wickUpColor: '#00e676',
      wickDownColor: '#ff1744',
      wickVisible: true,
      borderVisible: false,
    },
    volumeUp: 'rgba(0,230,118,0.35)',
    volumeDown: 'rgba(255,23,68,0.35)',
  },
  {
    id: 'hollow',
    label: 'Hollow bull',
    candle: {
      upColor: 'rgba(0,230,118,0.1)',
      downColor: '#ff1744',
      borderUpColor: '#00e676',
      borderDownColor: '#ff1744',
      wickUpColor: '#00e676',
      wickDownColor: '#ff5252',
      wickVisible: true,
      borderVisible: true,
    },
    volumeUp: 'rgba(0,230,118,0.35)',
    volumeDown: 'rgba(255,23,68,0.35)',
  },
  {
    id: 'trading-dark',
    label: 'TV dark',
    candle: {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#2bbd9a',
      borderDownColor: '#ff7960',
      wickUpColor: '#4db6ac',
      wickDownColor: '#e57373',
      wickVisible: true,
      borderVisible: true,
    },
    volumeUp: 'rgba(38,166,154,0.38)',
    volumeDown: 'rgba(239,83,80,0.38)',
  },
  {
    id: 'outline',
    label: 'Outline',
    candle: {
      upColor: 'rgba(144,202,249,0.12)',
      downColor: 'rgba(239,154,154,0.18)',
      borderUpColor: '#90caf9',
      borderDownColor: '#ef9a9a',
      wickUpColor: '#b0bec5',
      wickDownColor: '#b0bec5',
      wickVisible: true,
      borderVisible: true,
    },
    volumeUp: 'rgba(144,202,249,0.35)',
    volumeDown: 'rgba(239,154,154,0.35)',
  },
  {
    id: 'monochrome',
    label: 'Mono',
    candle: {
      upColor: '#cfd8dc',
      downColor: '#546e7a',
      borderUpColor: '#eceff1',
      borderDownColor: '#78909c',
      wickUpColor: '#90a4ae',
      wickDownColor: '#90a4ae',
      wickVisible: true,
      borderVisible: true,
    },
    volumeUp: 'rgba(207,216,220,0.4)',
    volumeDown: 'rgba(84,110,122,0.45)',
  },
  {
    id: 'bars',
    label: 'Bars (no wick)',
    candle: {
      upColor: '#00e676',
      downColor: '#ff1744',
      borderUpColor: '#00e676',
      borderDownColor: '#ff1744',
      wickUpColor: '#00e676',
      wickDownColor: '#ff1744',
      wickVisible: false,
      borderVisible: false,
    },
    volumeUp: 'rgba(0,230,118,0.35)',
    volumeDown: 'rgba(255,23,68,0.35)',
  },
  {
    id: 'oled',
    label: 'Neon OLED',
    candle: {
      upColor: '#00ffc8',
      downColor: '#ff2d6a',
      borderUpColor: '#5fffd4',
      borderDownColor: '#ff6b9d',
      wickUpColor: '#00ffc8',
      wickDownColor: '#ff2d6a',
      wickVisible: true,
      borderVisible: true,
    },
    volumeUp: 'rgba(0,255,200,0.32)',
    volumeDown: 'rgba(255,45,106,0.32)',
  },
];

const DEFAULT_ID = CANDLE_THEMES[0].id;

/**
 * @param {string | null | undefined} id
 * @returns {CandleTheme}
 */
export function getCandleTheme(id) {
  const found = CANDLE_THEMES.find((t) => t.id === id);
  return found ?? CANDLE_THEMES[0];
}

/** @returns {string} */
export function readStoredCandleThemeId() {
  try {
    const raw = localStorage.getItem(CANDLE_THEME_STORAGE_KEY);
    if (typeof raw === 'string' && raw && CANDLE_THEMES.some((t) => t.id === raw)) return raw;
  } catch {
    /* private mode */
  }
  return DEFAULT_ID;
}

/** @param {string} id */
export function storeCandleThemeId(id) {
  try {
    localStorage.setItem(CANDLE_THEME_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
