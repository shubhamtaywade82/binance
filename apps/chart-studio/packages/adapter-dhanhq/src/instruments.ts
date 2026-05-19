import axios from 'axios';
import type { InstrumentMeta, SymbolRef } from '@chart-studio/adapter-core';

const SCRIP_MASTER_URL = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
const REFRESH_MS = 12 * 60 * 60 * 1000; // 12h

export interface DhanInstrument {
  /** "NSE_EQ", "NSE_FNO", "BSE_EQ", "MCX_COMM", etc. */
  exchangeSegment: string;
  securityId: string;
  symbolName: string;
  displayName: string;
  instrumentType: string;
  /** "EQUITY" | "FUTSTK" | "OPTSTK" | "FUTIDX" | "OPTIDX" | ... */
  segment: string;
  exchId: string;
  lotSize: number;
  tickSize: number;
  expiryDate?: string;
  strikePrice?: number;
  optionType?: string;
  isin?: string;
}

const segmentLabelFor = (instrumentType: string): string => {
  if (instrumentType === 'EQUITY') return 'equity';
  if (instrumentType === 'INDEX') return 'index';
  if (instrumentType.startsWith('FUT')) return 'futures';
  if (instrumentType.startsWith('OPT')) return 'option';
  if (instrumentType === 'COMMODITY' || instrumentType === 'COM') return 'commodity';
  if (instrumentType === 'CURRENCY' || instrumentType === 'CUR') return 'currency';
  return instrumentType.toLowerCase();
};

const parseCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (ch === ',' && !inQuote) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
};

const parseScripMaster = (csv: string): DhanInstrument[] => {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toUpperCase());
  const idx = (name: string): number => header.indexOf(name);

  const cExch = idx('EXCH_ID');
  const cSegment = idx('SEGMENT');
  const cSecurityId = idx('SECURITY_ID') !== -1 ? idx('SECURITY_ID') : idx('SEM_SMST_SECURITY_ID');
  const cSymbol = idx('SYMBOL_NAME') !== -1 ? idx('SYMBOL_NAME') : idx('SEM_TRADING_SYMBOL');
  const cDisplay = idx('DISPLAY_NAME') !== -1 ? idx('DISPLAY_NAME') : idx('SM_SYMBOL_NAME');
  const cInstrumentType = idx('INSTRUMENT_TYPE') !== -1 ? idx('INSTRUMENT_TYPE') : idx('SEM_INSTRUMENT_NAME');
  const cExchangeSegment = idx('EXCHANGE_SEGMENT') !== -1 ? idx('EXCHANGE_SEGMENT') : idx('SEM_EXM_EXCH_ID');
  const cLotSize = idx('LOT_SIZE') !== -1 ? idx('LOT_SIZE') : idx('SEM_LOT_UNITS');
  const cTickSize = idx('TICK_SIZE') !== -1 ? idx('TICK_SIZE') : idx('SEM_TICK_SIZE');
  const cExpiry = idx('EXPIRY_DATE') !== -1 ? idx('EXPIRY_DATE') : idx('SEM_EXPIRY_DATE');
  const cStrike = idx('STRIKE_PRICE') !== -1 ? idx('STRIKE_PRICE') : idx('SEM_STRIKE_PRICE');
  const cOptionType = idx('OPTION_TYPE') !== -1 ? idx('OPTION_TYPE') : idx('SEM_OPTION_TYPE');
  const cIsin = idx('ISIN');

  const required = [cExch, cSecurityId, cSymbol, cInstrumentType];
  if (required.some((i) => i === -1)) return [];

  const segmentFromRow = (exchId: string, instrumentType: string, raw?: string): string => {
    if (raw && /^[A-Z_]+$/.test(raw)) return raw;
    if (instrumentType === 'EQUITY' || instrumentType === 'INDEX') {
      if (exchId === 'NSE') return 'NSE_EQ';
      if (exchId === 'BSE') return 'BSE_EQ';
    }
    if (instrumentType.startsWith('FUT') || instrumentType.startsWith('OPT')) {
      if (exchId === 'NSE') return 'NSE_FNO';
      if (exchId === 'BSE') return 'BSE_FNO';
      if (exchId === 'MCX') return 'MCX_COMM';
    }
    if (exchId === 'MCX') return 'MCX_COMM';
    return `${exchId}_EQ`;
  };

  const out: DhanInstrument[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const row = parseCsvLine(lines[i]!);
    const exchId = (row[cExch] ?? '').trim();
    const securityId = (row[cSecurityId] ?? '').trim();
    const symbol = (row[cSymbol] ?? '').trim();
    const instrumentType = (row[cInstrumentType] ?? '').trim();
    if (!exchId || !securityId || !symbol || !instrumentType) continue;
    const exchangeSegment = segmentFromRow(exchId, instrumentType, cExchangeSegment !== -1 ? (row[cExchangeSegment] ?? '').trim() : undefined);
    out.push({
      exchangeSegment,
      securityId,
      symbolName: symbol,
      displayName: cDisplay !== -1 ? (row[cDisplay] ?? symbol).trim() || symbol : symbol,
      instrumentType,
      segment: cSegment !== -1 ? (row[cSegment] ?? '').trim() : '',
      exchId,
      lotSize: cLotSize !== -1 ? Number(row[cLotSize]) || 1 : 1,
      tickSize: cTickSize !== -1 ? Number(row[cTickSize]) || 0.05 : 0.05,
      expiryDate: cExpiry !== -1 && row[cExpiry] ? row[cExpiry] : undefined,
      strikePrice: cStrike !== -1 && row[cStrike] ? Number(row[cStrike]) : undefined,
      optionType: cOptionType !== -1 && row[cOptionType] ? row[cOptionType] : undefined,
      isin: cIsin !== -1 && row[cIsin] ? row[cIsin] : undefined,
    });
  }
  return out;
};

let cache: { ts: number; rows: DhanInstrument[]; byKey: Map<string, DhanInstrument> } | null = null;

const buildIndex = (rows: DhanInstrument[]): Map<string, DhanInstrument> => {
  const m = new Map<string, DhanInstrument>();
  for (const r of rows) m.set(`${r.exchangeSegment}:${r.securityId}`, r);
  return m;
};

export const loadInstruments = async (overrideUrl?: string): Promise<DhanInstrument[]> => {
  if (cache && Date.now() - cache.ts < REFRESH_MS) return cache.rows;
  const url = overrideUrl ?? SCRIP_MASTER_URL;
  const { data } = await axios.get<string>(url, { timeout: 60_000, responseType: 'text', validateStatus: (s) => s === 200 });
  const rows = parseScripMaster(data);
  cache = { ts: Date.now(), rows, byKey: buildIndex(rows) };
  return rows;
};

export const findInstrument = (symbol: string): DhanInstrument | null => {
  if (!cache) return null;
  const [seg, id] = symbol.split(':');
  if (!seg || !id) return null;
  return cache.byKey.get(`${seg.toUpperCase()}:${id}`) ?? null;
};

export const toSymbolRef = (providerId: string, ins: DhanInstrument): SymbolRef => ({
  provider: providerId,
  symbol: `${ins.exchangeSegment}:${ins.securityId}`,
  label: ins.displayName || ins.symbolName,
  segment: segmentLabelFor(ins.instrumentType),
});

export const toInstrumentMeta = (providerId: string, ins: DhanInstrument): InstrumentMeta => ({
  ...toSymbolRef(providerId, ins),
  precision: { tickSize: ins.tickSize, stepSize: 1, minQty: ins.lotSize },
  exchangeId: ins.securityId,
  contractType: ins.instrumentType,
  expiry: ins.expiryDate ? Date.parse(ins.expiryDate) : undefined,
  intervals: ['1', '5', '15', '25', '60', '1D'],
});

export const searchInstruments = (rows: DhanInstrument[], query: string, limit: number): DhanInstrument[] => {
  const q = query.trim().toUpperCase();
  if (!q) return rows.slice(0, limit);
  const out: DhanInstrument[] = [];
  for (const r of rows) {
    const hay = `${r.symbolName} ${r.displayName} ${r.exchangeSegment}`.toUpperCase();
    if (hay.includes(q)) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
};
