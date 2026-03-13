/**
 * Quoted message download-code cache.
 *
 * Persists `msgId → CacheEntry` per (accountId, conversationId) bucket so that
 * when a user quotes a file/video/audio message the bot didn't originally see,
 * we can still recover the downloadCode (or spaceId+fileId) to fetch it.
 *
 * - TTL: 24 h
 * - Per-bucket cap: 100 entries (LRU eviction)
 * - Max buckets: 1000 (LRU eviction)
 * - Atomic write (tmp + rename)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuotedMsgCacheEntry {
  downloadCode?: string;
  spaceId?: string;
  fileId?: string;
  msgType: string;       // 'audio' | 'video' | 'file'
  createdAt: number;     // ms timestamp from DingTalk
  cachedAt: number;      // Date.now() when we cached it
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;       // 24 h
const MAX_ENTRIES_PER_BUCKET = 100;
const MAX_BUCKETS = 1000;

const CACHE_FILE = path.join(
  os.homedir(),
  ".openclaw", "extensions", "dingtalk", ".cache", "quoted-msg-cache.json",
);

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/** bucketKey → Map<msgId, entry> */
const store = new Map<string, Map<string, QuotedMsgCacheEntry>>();

/** Ordered list of bucket keys for LRU eviction (most-recently-used at end) */
let bucketOrder: string[] = [];

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadFromDisk(): void {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const data: Record<string, Array<[string, QuotedMsgCacheEntry]>> = JSON.parse(raw);
    const cutoff = Date.now() - DEFAULT_TTL_MS;

    for (const [bucketKey, entries] of Object.entries(data)) {
      const bucket = new Map<string, QuotedMsgCacheEntry>();
      for (const [msgId, entry] of entries) {
        if (entry.cachedAt > cutoff) {
          bucket.set(msgId, entry);
        }
      }
      if (bucket.size > 0) {
        store.set(bucketKey, bucket);
        bucketOrder.push(bucketKey);
      }
    }
  } catch {
    // Silently ignore corrupt/missing file
  }
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const obj: Record<string, Array<[string, QuotedMsgCacheEntry]>> = {};
      for (const [bk, bucket] of store) {
        obj[bk] = [...bucket.entries()];
      }
      const tmp = CACHE_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj), "utf-8");
      fs.renameSync(tmp, CACHE_FILE);
    } catch {
      // Best-effort persistence
    }
  }, 2000);
}

// Load on module init
loadFromDisk();

// ---------------------------------------------------------------------------
// Bucket helpers
// ---------------------------------------------------------------------------

function bucketKey(accountId: string, conversationId: string): string {
  return `${accountId}:${conversationId}`;
}

/** Touch a bucket in the LRU order (move to end). */
function touchBucket(key: string): void {
  const idx = bucketOrder.indexOf(key);
  if (idx >= 0) bucketOrder.splice(idx, 1);
  bucketOrder.push(key);
}

function getOrCreateBucket(key: string): Map<string, QuotedMsgCacheEntry> {
  let bucket = store.get(key);
  if (!bucket) {
    // Evict oldest buckets if at limit
    while (bucketOrder.length >= MAX_BUCKETS) {
      const oldest = bucketOrder.shift();
      if (oldest) store.delete(oldest);
    }
    bucket = new Map();
    store.set(key, bucket);
  }
  touchBucket(key);
  return bucket;
}

/** LRU-evict within a bucket to stay under MAX_ENTRIES_PER_BUCKET. */
function evictBucket(bucket: Map<string, QuotedMsgCacheEntry>): void {
  if (bucket.size <= MAX_ENTRIES_PER_BUCKET) return;

  // Expire stale entries first
  const cutoff = Date.now() - DEFAULT_TTL_MS;
  for (const [k, v] of bucket) {
    if (v.cachedAt < cutoff) bucket.delete(k);
  }

  // If still over, remove oldest by cachedAt
  while (bucket.size > MAX_ENTRIES_PER_BUCKET) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, v] of bucket) {
      if (v.cachedAt < oldestTs) {
        oldestTs = v.cachedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) bucket.delete(oldestKey);
    else break;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function cacheInboundDownloadCode(
  accountId: string,
  conversationId: string,
  msgId: string,
  downloadCode: string | undefined,
  msgType: string,
  createdAt: number,
  extra?: { spaceId?: string; fileId?: string },
): void {
  const bk = bucketKey(accountId, conversationId);
  const bucket = getOrCreateBucket(bk);

  bucket.set(msgId, {
    downloadCode,
    spaceId: extra?.spaceId,
    fileId: extra?.fileId,
    msgType,
    createdAt,
    cachedAt: Date.now(),
  });

  evictBucket(bucket);
  scheduleSave();
}

export function getCachedDownloadCode(
  accountId: string,
  conversationId: string,
  msgId: string,
): QuotedMsgCacheEntry | null {
  const bk = bucketKey(accountId, conversationId);
  const bucket = store.get(bk);
  if (!bucket) return null;

  const entry = bucket.get(msgId);
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.cachedAt > DEFAULT_TTL_MS) {
    bucket.delete(msgId);
    scheduleSave();
    return null;
  }

  touchBucket(bk);
  return entry;
}
