// Password hashing, authenticator-app codes (RFC 6238), sessions and rate limiting.
import { scryptSync, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  return timingSafeEqual(scryptSync(String(password), Buffer.from(salt, 'hex'), expected.length), expected);
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function safeEqual(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  let bits = '';
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{5}/g).map(chunk => ALPHABET[parseInt(chunk, 2)]).join('');
}
function totpAt(secret, counter) {
  let bits = '';
  for (const char of secret) bits += ALPHABET.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}
export function verifyTotp(secret, code, now = Date.now()) {
  const value = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(value) || !secret) return false;
  const counter = Math.floor(now / 30000);
  return [-1, 0, 1].some(step => safeEqual(totpAt(secret, counter + step), value));
}
export const totpNow = secret => totpAt(secret, Math.floor(Date.now() / 30000));

// Sessions live in memory: restarting the server signs everyone out.
const sessions = new Map();
const SESSION_HOURS = 12;
export function createSession(userId, pending = false) {
  const token = randomBytes(32).toString('base64url');
  sessions.set(sha256(token), { userId, pending, expires: Date.now() + (pending ? 10 * 60000 : SESSION_HOURS * 3600000) });
  return token;
}
export function getSession(token) {
  if (!token) return null;
  const key = sha256(token);
  const session = sessions.get(key);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(key); return null; }
  return session;
}
export const dropSession = token => token && sessions.delete(sha256(token));
export function dropUserSessions(userId, exceptToken) {
  const keep = exceptToken && sha256(exceptToken);
  for (const [key, session] of sessions) if (session.userId === userId && key !== keep) sessions.delete(key);
}

const buckets = new Map();
// Returns false once `max` attempts have been made for `key` within the window.
export function allow(key, max, windowMs) {
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter(time => now - time < windowMs);
  if (recent.length >= max) { buckets.set(key, recent); return false; }
  recent.push(now);
  buckets.set(key, recent);
  return true;
}
export const clearAttempts = key => buckets.delete(key);
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of buckets) if (!times.some(time => now - time < 3600000)) buckets.delete(key);
  for (const [key, session] of sessions) if (session.expires < now) sessions.delete(key);
}, 600000).unref();
