import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';

export const buildSignedPayloadString = (params: Record<string, string | number | boolean>): string => {
  const pairs = Object.entries(params)
    .filter(([k]) => k !== 'signature')
    .map(([k, v]) => [k, typeof v === 'string' ? v : String(v)] as [string, string])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export const signPayloadEd25519Base64 = (payloadAscii: string, privateKey: KeyObject): string => {
  const sig = cryptoSign(null, Buffer.from(payloadAscii, 'utf8'), privateKey);
  return sig.toString('base64');
}

export const loadEd25519PrivateKeyFromPem = (pem: string): KeyObject => {
  return createPrivateKey(pem);
}
