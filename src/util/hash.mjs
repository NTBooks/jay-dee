import { createHash } from 'node:crypto';
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex');
export const nowIso = () => new Date().toISOString();
