// Exact port of the Norm() helper from the earlier PowerShell playlist builder,
// plus NFKD diacritic stripping and curly-quote handling.
// lower, trim, drop leading "the ", $->s, !->i, strip everything but [a-z0-9].
export function nameKey(s) {
  if (s == null) return '';
  let x = String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  x = x.toLowerCase().trim();
  x = x.replace(/^the\s+/, '');
  x = x.replace(/\$/g, 's').replace(/!/g, 'i');
  x = x.replace(/[^a-z0-9]/g, '');
  return x;
}

// Titles: same idea, but also drop bracketed qualifiers like (Remastered), [Live], feat. credits.
export function titleKey(s) {
  if (s == null) return '';
  let x = String(s);
  x = x.replace(/\s*[\(\[][^\)\]]*(remaster|live|version|edit|mix|mono|stereo|demo|bonus|feat\.?|ft\.?|explicit|deluxe|instrumental)[^\)\]]*[\)\]]/gi, '');
  x = x.replace(/\s+(feat|ft)\.?\s+.*$/i, '');
  return nameKey(x);
}

const COMPILATION_KEYS = new Set([
  'variousartists', 'various', 'soundtrack', 'ost', 'originalsoundtrack',
  'originalmotionpicturesoundtrack', 'va', 'unknownartist', 'unknown', 'compilation',
]);
export function isCompilationArtist(name) {
  return COMPILATION_KEYS.has(nameKey(name));
}

export function isCollabName(name) {
  if (!name) return false;
  return /\s(&|and|x|×|feat\.?|ft\.?|with|vs\.?|\/)\s|,/i.test(String(name));
}

export function ticksToSeconds(ticks) {
  return ticks ? Number(ticks) / 10_000_000 : null;
}
