import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSignedPayloadString,
  loadEd25519PrivateKeyFromPem,
  signPayloadEd25519Base64,
} from '../src/binance/futures-ws-sign';

describe('futures-ws-sign', () => {
  it('builds alphabetically sorted payload excluding signature', () => {
    expect(
      buildSignedPayloadString({
        timestamp: 99,
        apiKey: 'abc',
        signature: 'SHOULD_DROP',
      }),
    ).toBe('apiKey=abc&timestamp=99');
  });

  it('signs Ed25519 payload that verifies with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const payload = 'price=0.20&quantity=1&symbol=BTCUSDT';
    const keyObj = loadEd25519PrivateKeyFromPem(pem);
    const b64 = signPayloadEd25519Base64(payload, keyObj);
    const sig = Buffer.from(b64, 'base64');
    const ok = verify(null, Buffer.from(payload, 'utf8'), publicKey, sig);
    expect(ok).toBe(true);
  });
});
