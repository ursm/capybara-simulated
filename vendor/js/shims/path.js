// Minimal POSIX-style path shim — happy-dom uses join/basename/extname for
// virtual server file lookups, which our driver does not exercise. Keep the
// surface plausible so module loads do not crash.
export function basename(p) { return String(p).split('/').pop() || ''; }
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i);
}
export function dirname(p) {
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
export function join(...parts) {
  return parts.map(String).filter(Boolean).join('/').replace(/\/+/g, '/');
}
export function resolve(...parts) { return join(...parts); }
export const sep = '/';
export const delimiter = ':';
export default {basename, extname, dirname, join, resolve, sep, delimiter};
