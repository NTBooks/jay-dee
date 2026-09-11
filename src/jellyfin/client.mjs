import { config } from '../config.mjs';
import { fetchJson } from '../util/http.mjs';

export const AUDIO_FIELDS = 'Genres,Artists,AlbumArtist,AlbumArtists,ArtistItems,AlbumId,ProductionYear,PremiereDate,RunTimeTicks,IndexNumber,ParentIndexNumber,Path,ProviderIds,DateCreated,Container,SortName,Tags,Studios,NormalizationGain,HasLyrics,ImageTags';
export const ALBUM_FIELDS = 'Genres,ProductionYear,PremiereDate,ProviderIds,AlbumArtists,ArtistItems,ChildCount,DateCreated,Path,Overview,RunTimeTicks,SortName,ImageTags';
export const ARTIST_FIELDS = 'Genres,ProviderIds,Overview,DateCreated,Path,SortName,ImageTags,BackdropImageTags';

export class JellyfinClient {
  constructor({ baseUrl = config.jellyfin.url, apiKey = config.jellyfin.apiKey, userId = config.jellyfin.userId } = {}) {
    if (!apiKey) throw new Error('JELLYFIN_API_KEY missing (set it in .env)');
    this.base = baseUrl;
    this.apiKey = apiKey;
    this.userId = userId;
    this.headers = { 'X-Emby-Token': apiKey };
  }

  async info() {
    return fetchJson(`${this.base}/System/Info`, { headers: this.headers, timeoutMs: 10_000, retries: 1 });
  }

  async count(includeItemTypes) {
    const r = await fetchJson(`${this.base}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&Limit=0`, { headers: this.headers });
    return r.TotalRecordCount;
  }

  // Yields pages {items, total, startIndex}. Stable sort so pages don't overlap.
  async libraries() {
    const v = await fetchJson(`${this.base}/Library/VirtualFolders`, { headers: this.headers });
    return (v || []).filter((f) => f.CollectionType === 'music');
  }

  async *pageItems(includeItemTypes, fields, { limit = 1000, parentId } = {}) {
    let start = 0;
    let total = Infinity;
    while (start < total) {
      const url = `${this.base}/Items?IncludeItemTypes=${includeItemTypes}&Recursive=true&Fields=${encodeURIComponent(fields)}&SortBy=SortName,Id&SortOrder=Ascending&StartIndex=${start}&Limit=${limit}&EnableImages=false${parentId ? `&ParentId=${parentId}` : ''}`;
      const r = await fetchJson(url, { headers: this.headers, timeoutMs: 120_000, retries: 3 });
      total = r.TotalRecordCount;
      const items = r.Items || [];
      yield { items, total, startIndex: start };
      if (items.length === 0) break;
      start += items.length;
    }
  }

  async getItem(id) {
    return fetchJson(`${this.base}/Items/${id}?Fields=${encodeURIComponent(AUDIO_FIELDS)}`, { headers: this.headers, retries: 1 });
  }

  streamUrl(id) { return `${this.base}/Audio/${id}/stream?static=true`; }
  universalUrl(id) {
    const q = new URLSearchParams({ UserId: this.userId, DeviceId: 'jaydee', MaxStreamingBitrate: '320000', Container: 'mp3', AudioCodec: 'mp3', TranscodingContainer: 'mp3', TranscodingProtocol: 'http' });
    return `${this.base}/Audio/${id}/universal?${q}`;
  }
  imageUrl(id, { type = 'Primary', maxWidth = 600, index } = {}) {
    const q = new URLSearchParams({ maxWidth: String(maxWidth), quality: '90' });
    return `${this.base}/Items/${id}/Images/${type}${index != null ? '/' + index : ''}?${q}`;
  }

  // Raw fetch for proxying (audio/images). Returns the Response.
  async fetchRaw(url, { range, signal } = {}) {
    const headers = { ...this.headers };
    if (range) headers.range = range;
    return fetch(url, { headers, signal });
  }
}
