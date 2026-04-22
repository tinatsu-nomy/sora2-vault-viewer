# Output Specification for sora2-vault-viewer

> **Spec version**: matches extension `manifest.json` version. Current: **2.1.0** (fixed 2026-04-19). `items[*].replies[]` and recursive reply-tree fetch added in this version; validated with zero data loss across ~100 posts × ~170 replies in production scan.

This document defines the **output contract** that `nomy/chrome extension/` must satisfy so that exported data can be correctly consumed by [sora2-vault-viewer](https://github.com/tinatsu-nomy/sora2-vault-viewer). The contract is derived from the viewer's indexing logic (`sora2-vault-viewer/app/indexing/**`, `server_runtime.js`, `store.js`) and described from the producer's (this extension's) perspective.

- Producer: `nomy/chrome extension/content.js` — writes manifest JSON, TXT sidecars, and MP4 files via the File System Access API.
- Consumer: `sora2-vault-viewer/app/**` — a Node.js server that walks `sora2_data/`, builds an index, and serves the gallery on `127.0.0.1:3210`.
- Stamping: each exported manifest embeds `"soravault_version": "2.1.0"` at the top level so consumers can branch on producer version when field layouts evolve.

---

## 1. Top-Level Directory Layout

The viewer expects the following layout under its data root. `sora2_data/` is the directory the viewer recognizes as `SORA_DATA_DIR`, and it must be the same folder the user selects as the export root in this extension.

```text
sora2_data/
  soravault_manifest_YYYY-MM-DD_HHMMSS.json
  soravault_manifest_merged_YYYY-MM-DD_HHMMSS.json
  soravault_manifest_merged_YYYY-MM-DD_HHMMSS_part01.json
  sora_v1_images/                  # source key: v1_library  (NOT indexed by viewer)
  sora_v1_liked/                   # source key: v1_liked    (NOT indexed by viewer)
  sora_v2_profile/                 # source key: v2_profile
  sora_v2_drafts/                  # source key: v2_drafts
  sora_v2_liked/                   # source key: v2_liked
  sora_v2_cameos/                  # source key: v2_cameos
  sora_v2_cameo_drafts/            # source key: v2_cameo_drafts
  sora_v2_@{username}/             # source key: v2_@{username}
  sora_characters_@{ownerUsername}/
  sora_v2_char_@{characterName}/
  sora_v2_char_drafts_@{characterName}/
  avatars/                         # optional — used by the viewer's /avatar endpoint
```

### 1.1 Source Directory Detection (Viewer Side)

`sora2-vault-viewer/app/server_runtime.js:40` (`discoverSourceDirs()`) only picks up directories whose name **starts with `sora_v2_`** directly under `sora2_data/`. The directory name with the leading `sora_` stripped becomes the `source key`.

| Directory name                          | Viewer `source key`               | Notes                                 |
| --------------------------------------- | --------------------------------- | ------------------------------------- |
| `sora_v2_profile`                       | `v2_profile`                      | Highest-priority source (sorts first) |
| `sora_v2_drafts`                        | `v2_drafts`                       |                                       |
| `sora_v2_liked`                         | `v2_liked`                        |                                       |
| `sora_v2_cameos`                        | `v2_cameos`                       |                                       |
| `sora_v2_cameo_drafts`                  | `v2_cameo_drafts`                 |                                       |
| `sora_v2_@{username}`                   | `v2_@{username}`                  | Custom user source (sorts last)       |
| `sora_v2_char_@{characterName}`         | `v2_char_@{characterName}`        |                                       |
| `sora_v2_char_drafts_@{characterName}`  | `v2_char_drafts_@{characterName}` |                                       |

> **The v1 directories (`sora_v1_images` / `sora_v1_liked`) are NOT indexed by the viewer** because they do not match `/^sora_v2_.+/i`. The viewer's README also explicitly states "Sora 1 data is not supported." You may emit v1 data, but it will not appear in the viewer UI.

---

## 2. Manifest JSON Specification

### 2.1 File Name

The viewer only indexes files matching one of the following two regular expressions (`sora2-vault-viewer/app/indexing/manifest.js:8-9`):

```regex
^soravault_manifest_merged_\d{4}-\d{2}-\d{2}_\d{6}_part\d+\.json$   # merged split
^soravault_manifest_.+\.json$                                        # legacy / single
```

The extension currently produces:

- Regular export (`content.js:1543`) — `soravault_manifest_YYYY-MM-DD_HHMMSS.json`
- `merge_manifests.py` output — `soravault_manifest_merged_YYYY-MM-DD_HHMMSS_partNN.json` (split) / `soravault_manifest_merged_YYYY-MM-DD_HHMMSS.json` (single)

Both are accepted. **Any file whose name does not start with `soravault_manifest_` will be ignored.**

### 2.2 Top-Level Schema

```jsonc
{
  "soravault_version": "2.0.0",                         // optional, viewer ignores
  "exported_at": "2026-04-18T12:34:56.789Z",            // ISO-8601, becomes manifestExportedAt
  "scan_sources": ["v2_profile", "v2_liked"],           // optional, parsed by the indexer but not currently exposed by /api/stats
  "total": 1234,                                        // optional, displayed only
  "merged_from": 3,                                     // merged-only, viewer ignores
  "items": [ /* ItemEntry[] */ ]                        // required
}
```

| Key             | Type   | Required | Viewer behavior                                                                  |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `exported_at`   | string | recommended | Surfaces as `manifests[*].exportedAt` and propagates to each item's `manifestExportedAt` |
| `scan_sources`  | array  | optional | Parsed into in-memory manifest metadata, but not currently serialized by `/api/stats` |
| `total`         | number | optional | Passed through as `stats.manifests[*].total`                                     |
| `items`         | array  | **required** | Empty arrays are allowed. Non-arrays are not tolerated by the current stream parser. |

### 2.3 `items[]` Schema (ItemEntry)

These are the keys consumed by the viewer's `parseManifestItem()`. **Required** means the viewer needs at least one of them to identify the item as a distinct entry. Anything else may be omitted — missing fields are treated as `null`/empty.

| Key             | Type                       | Required | Meaning / viewer usage                                                       |
| --------------- | -------------------------- | -------- | ---------------------------------------------------------------------------- |
| `source`        | string                     | recommended | Source key (see §1.1). Defaults to `"unknown"` if omitted.                |
| `mode`          | `"v1"` / `"v2"` / `"character"` | optional | Included in search text                                                |
| `genId`         | string                     | recommended | First candidate for `entry.id`. Used to match against local files          |
| `generation_id` (※) | -                      | -        | Derived from `_raw.generation_id` or `_raw.post.attachments[0].generation_id` |
| `taskId`        | string                     | optional | Auxiliary matching key                                                     |
| `postId`        | string                     | optional | v2 post ID. Falls back as id candidate if `genId` is missing.              |
| `date`          | `YYYY-MM-DD` or ISO-8601   | recommended | Used for display and sort (empty values sort last)                       |
| `prompt`        | string                     | recommended | Searched and shown in the detail panel                                    |
| `width`         | number                     | optional | Falls back to `_raw.width`                                                 |
| `height`        | number                     | optional | Falls back to `_raw.height`                                                |
| `ratio`         | string                     | optional | e.g. `"16:9"`                                                              |
| `duration`      | number (seconds)           | optional | Falls back to `_raw.duration_s`. Treated numerically when sorting.        |
| `previewUrl`    | string                     | optional | External preview link in detail panel when `SORA_VIEWER_DEBUG=1`          |
| `downloadUrl`   | string                     | optional | Download link in detail panel when `SORA_VIEWER_DEBUG=1`                   |
| `thumbUrl`      | string                     | optional | Gallery thumbnail fallback; external link is shown only when `SORA_VIEWER_DEBUG=1` |
| `isLiked`       | boolean                    | optional | Used by the "liked" filter                                                 |
| `_raw`          | object                     | strongly recommended | See §2.4. Source of post body, author, cameos, view/like counts. |

> (※) `generation_id` / `task_id` are **not** read from the top-level item — they come from `_raw.generation_id` and `_raw.post.attachments[0].generation_id` (`manifestIdentity()` @ `manifest.js:35`). It is fine to populate both top-level (`genId`/`taskId`) and `_raw` (the viewer is happy as long as one place has the value).

### 2.4 The `_raw` Contract

The viewer treats `_raw` not as debug noise, but as the **primary source for body and attribute extraction**. Stripping `_raw` will erase nearly all v2 metadata.

```jsonc
_raw: {
  // For post-based sources (v2_profile / v2_liked / etc.):
  post: {
    id: "s_...",
    text: "caption ...",                   // prompt fallback
    caption: "...",
    permalink: "https://sora.chatgpt.com/...",
    posted_at: 1713400000,                 // unix seconds
    updated_at: 1713400000,
    user_liked: true,
    like_count: 42,                        // viewer's likeCount
    view_count: 1000,                      // viewer's viewCount
    attachments: [
      {
        id: "s_...",
        generation_id: "gen_...",
        task_id: "task_...",
        width: 1920,
        height: 1080,
        duration_s: 5.2,
        type: "video",
        model: "...",
        style: "...",
        // download/preview URLs come from the top-level item, so they are not read here
      },
    ],
    cameo_profiles: [                      // used for cameoOwnerUsernames and avatar resolution
      { username: "alice", user_id: "u_...", display_name: "...", description: "..." },
    ],
    text_facets: [
      { profile: { username: "bob", user_id: "u_...", ... } },
    ],
    discovery_phrase: "...",
    audience_description: "...",
    emoji: "...",
    visibility: "...",
  },

  profile: {                               // posterUsername / profileUserId / avatar resolution
    username: "alice",
    user_id: "u_...",
    display_name: "...",
    description: "...",
    location: "...",
    public_figure_name: "...",
    owner_profile: { /* recursive */ },
  },

  // For v2_drafts and similar sources where attachment-like fields are flat under _raw.
  // The viewer treats post.attachments[0] as primary, falling back to _raw itself.
  generation_id: "gen_...",
  task_id: "task_...",
  width: 1920,
  height: 1080,
  duration_s: 5.2,

  model: "...",
  style: "...",
  prompt: "...",                           // fallback when both item.prompt and post.text are empty
}
```

### 2.5 Deduplication Key

For each item, the viewer uses the **first non-null value** in this order as the dedupe key (`manifestIdentity()` @ `manifest.js:35`):

1. `item.genId`
2. `_raw.generation_id` or `_raw.post.attachments[0].generation_id`
3. `item.postId` or `_raw.post.id`
4. `item.taskId` or `_raw.task_id` or `_raw.post.attachments[0].task_id`

Manifest files are processed in descending priority order (`exported_at` DESC, then file name DESC). However, the current duplicate merge call is `mergeManifestEntries(entry, existingEntry)`, and `mergeManifestEntries()` prefers its first argument for nearly all scalar fields. In practice, this means an older duplicate can override values from a newer manifest instead of acting as missing-field backfill. Treat current duplicate resolution as "last duplicate wins for most scalar fields", not as a stable newer-first merge contract.

### 2.6 ID Token Extraction

To match items against local files, the viewer extracts ID tokens with these patterns (`extractIdTokens()` @ `common.js:57`):

```regex
/gen_[a-z0-9]+/gi
/task_[a-z0-9]+/gi
/s_[a-z0-9]+(?:-attachment-\d+)?/gi
```

Source fields are `item.genId / taskId / postId` and `_raw.post.attachments[0].{generation_id, id, task_id}`. **Always preserve the original Sora-side prefixes (`gen_`, `task_`, `s_`)** in the values you emit — stripping them lowers the matching score against local files.

### 2.7 Optional `replies[]` (Producer Extension Data)

When the producer's **"Fetch replies"** option is enabled, each `mode: "v2"` item whose `_raw.post.reply_count > 0` may gain a top-level `replies[]` field. Each entry is a flattened descendant of the reply tree returned by `GET https://sora.chatgpt.com/backend/project_y/post/{postId}/tree`.

As of the current viewer implementation, `replies[]` is not indexed, rendered, or exposed as a first-class API field. It is safe to include for forward compatibility and downstream tooling, but it is not part of the viewer's active consumption contract today.

- The array is **flat** (not nested). The parent-child relationship is preserved via `parentId` — a direct reply has `parentId === item.postId`, a nested reply's `parentId` is another entry's `id`.
- Posts with `tombstoned_at != null` (deleted by the author) are filtered out at the producer side. The viewer may assume all entries are live.
- Entries are appended in the order the API returned them: each page of direct replies first, then recursion into sub-trees. The viewer should sort by `postedAt` (ascending) if chronological display is wanted.
- Absent when the feature is disabled or the post has zero replies. Downstream tooling should treat missing `replies[]` as "not fetched", not as "zero replies" — use `_raw.post.reply_count` for the authoritative count.

```jsonc
replies: [
  {
    id: "69e15f548a20...",                // reply post ID (no "s_" prefix for non-root replies)
    parentId: "s_69df662b...",             // the post this reply is attached to
    rootPostId: "s_69de2ae0...",           // top of the thread (may equal item.postId)
    user: "bigscarydragon",                // profile.username
    displayName: "Big Scary Dragon",       // profile.display_name (may be null)
    userId: "user-t0hrffziKOE...",         // profile.user_id
    text: "Copying just enough, but not too much",
    postedAt: 1776377684.539632,           // unix seconds (float)
    likeCount: 0,
    replyCount: 0                          // number of direct children this reply has
  }
]
```

**Producer-side notes:**

- Fetched via `fetchRepliesTree(postId)` in `content.js` with `limit=20` (`CFG.REPLIES_PAGE_LIMIT`) and `max_depth=1` (`CFG.REPLIES_MAX_DEPTH`).
- **Recursion into nested sub-threads is ON by default** (`CFG.REPLIES_RECURSE = true`). The full reply tree including comment-on-comment chains is captured. Set `CFG.REPLIES_RECURSE = false` to stop at direct replies only — fewer API calls, but sub-threads are truncated.
- Throttled at `CFG.REPLIES_POST_DELAY` (default 100 ms) between posts and `CFG.REPLIES_PAGE_DELAY` (default 500 ms) between pagination/recursion calls. The higher page delay prevents burst depletion of Sora's token bucket when deep sub-threads trigger multiple sub-calls. Both are tunable in the CFG block of `content.js` without rebuilding.
- Sora's `/tree` endpoint enforces a token-bucket style rate limit and does NOT emit a `Retry-After` header. `fetchWithRetry` applies **exponential backoff with jitter** when a 429 is received: 3 s → 6 s → 12 s → 24 s → 48 s (doubling per attempt) ±20 % random jitter. The reply-fetch path runs with `CFG.REPLIES_MAX_RETRIES = 6` (vs the main scan's `3`), because deeply-depleted token buckets occasionally need >20 s to recover. The final attempt's sleep is skipped since no retry follows it. When the server explicitly sends `Retry-After`, that value takes precedence. Tunables: `CFG.RATE_LIMIT_BACKOFF_BASE_SEC`, `CFG.RATE_LIMIT_BACKOFF_JITTER`, `CFG.REPLIES_MAX_RETRIES`.
- With recursion on, expect 1 API call per post for simple threads and 2-10× for posts with deep discussions (each sub-branch with `recursive_reply_count > 0` triggers a separate fetch).
- Network errors for individual posts are logged but do not abort the scan — the corresponding item simply lacks `replies[]`.
- **Consumer implication**: `replies[]` represents *what was fetched*, which may be a strict subset of all replies that exist for the post. The authoritative total remains `_raw.post.reply_count`. If `replies.length < reply_count`, the producer either used shallow mode or hit transient errors on some calls.
- **Viewer implication today**: the bundled viewer ignores this field. Do not depend on it for current UI behavior unless the viewer is extended explicitly.

---

## 3. Local Files (mp4 / txt) Naming and Placement

### 3.1 Placement

Each item's media goes under the corresponding source directory from §1. Subdirectories are allowed (`walkFiles()` @ `local-match.js:18` walks recursively).

```text
sora_v2_profile/
  2026-04-18_gen_abcd1234.mp4
  2026-04-18_gen_abcd1234.txt
```

### 3.2 File Name Template

The default in `content.js:34` is `{date}_{genId}` (extension auto-appended). To guarantee the viewer can link the files:

- The mp4 and txt **stems (the part without the extension) must match exactly** (`local-match.js:258`)
- The stem or the txt metadata must contain at least one ID also present on the manifest item

Recommended templates:

- v2 (post-based): `{date}_{genId}` — e.g. `2026-04-18_gen_abcd1234.mp4`
- v2 (with post): `{date}_{postId}` also works because the stem produces an `s_...` token via `extractIdTokens`
- character mode: `{date}_{genId}` (matching is mostly username-based via TXT metadata)

Stems may contain slashes or `@` as long as the file name is valid. Note that the viewer applies `slugForText = toLowerCase()`, so **two files that differ only in case are treated as the same**.

### 3.3 How to Score Highly in the Matcher

The viewer's matching score is computed as follows (`scoreLocalMatch()` @ `local-match.js:167`):

- If TXT-side `Generation ID` / `Post ID` / `Task ID` exist but **do not exactly match the same field on the item**, the score is `-1` (no match)
- If they match: +100 / +90 / +80 respectively (per field that exists)
- If `gen_*` / `task_*` / `s_*` tokens in the stem or TXT body match the item's token set: +10 each
- If the TXT prompt equals the item's prompt: +5

In short, **writing the `Generation ID` line in the TXT is the single most important thing**. Matching with mp4 alone (no TXT) is possible, but only if the file stem itself contains an ID.

---

## 4. TXT Sidecar Specification

### 4.1 Encoding

The viewer decodes with both UTF-8 and Shift_JIS, then picks the better-scoring result (`text.js:130`). The candidate without mojibake characters (`�`, `ƒ`, `„`, ...) wins. **UTF-8 (no BOM) is recommended.** The current `content.js` writes UTF-8 strings as-is.

### 4.2 Layout

A TXT sidecar consists of a line-oriented key/value block, a `Prompt` separator line, and the body. The viewer's parser (`parseTxtRecord()` @ `text.js:143`):

- Extracts metadata from any line matching `^([^:]+?)\s*:\s*(.+)$`
- Uses the first line containing the word `Prompt` as a separator, and **joins all lines after it as the `prompt` body**

> ⚠️ Any line containing the literal substring `Prompt` is treated as the separator. Avoid using metadata labels like "Prompt tuning" — the body would start there.

### 4.3 Recommended Format for `mode: "v2"`

This matches what `buildTxtContent()` (`content.js:1465`) currently emits. **Bold labels are required label strings** that the viewer matches verbatim — renaming any of them breaks ID extraction on the viewer side.

```text
Source         : v2_profile
**Generation ID**  : gen_abcd1234
**Task ID**        : task_xyz789
Date           : 2026-04-18
**Post ID**        : s_0123abcd
Duration       : 5.2s
Author         : @alice
Display Name   : Alice
Cameos         : @bob, @carol
Resolution     : 1920 × 1080 px
**Aspect ratio**   : 16:9
Quality        : hd
Model          : sora-2
Seed           : 12345
**Liked**          : yes

── Prompt ─────────────────────────────────────────────────
your prompt text here
multi-line ok
```

| TXT label         | Viewer field                           | Purpose                                                |
| ----------------- | -------------------------------------- | ------------------------------------------------------ |
| `Source`          | `local.parsed.declaredSource`          | Used for cross-matching across custom sources         |
| `Generation ID`   | `local.parsed.generationId`            | **Strict match required (when present)**              |
| `Task ID`         | `local.parsed.taskId`                  | **Strict match required (when present)**              |
| `Post ID`         | `local.parsed.postId`                  | **Strict match required (when present)**              |
| `Date`            | `local.parsed.date`                    | Fallback `date` for local-only items                  |
| `Duration`        | `local.parsed.duration`                | Fallback `duration` for local-only items              |
| `Resolution`      | `local.parsed.resolution`              | Display only                                           |
| `Aspect ratio`    | `local.parsed.aspectRatio`             | Fallback `ratio` for local-only items                 |
| `Liked`           | `local.parsed.liked` (compared to `"yes"`) | Fallback `isLiked` for local-only items           |

> Other labels like `Author` / `Model` / `Seed` / `Cameos` are **not** mapped to dedicated fields, but **they ARE included in the full-text search index (`searchText`)**, so they remain useful for human searches.

### 4.4 Recommended Format for `mode: "character"`

Matches what `buildTxtContent()` (`content.js:1465`) currently emits. The viewer only uses the three labels (`Generation ID` / `Post ID` / `Task ID`) for structured matching; everything else feeds the full-text search. Character-mode TXT files have no ID, so matching relies on the **username-based alias mechanism via the `sora_characters_@{ownerUsername}/` directory** (`applyCustomSourceAliases()` @ `local-match.js:215`).

```text
Source         : v2_characters
Type           : Owner Profile
User ID        : u_...
Username       : alice
Display Name   : Alice
Owner          : alice
Owner User ID  : u_...
Date           : 2026-04-18
Permalink      : https://sora.chatgpt.com/...
Likes Received : 42
```

---

## 5. Avatar Images (Optional)

Locations and naming the viewer's `/avatar` endpoint searches (`server_runtime.js:230-320`):

1. Under `sora2_data/sora_characters_@{ownerUsername}/`:
   - `owner_{username}*.{png|jpg|jpeg|webp|gif|avif|bmp|svg}` — for the `poster` role
   - `character_{username}*.*` / `owner_{username}*.*` — for the `cameo` role
2. Under `sora2_data/avatars/cameo/`, `sora2_data/avatars/users/`, `sora2_data/avatars/profiles/`, `sora2_data/avatars/`:
   - `{userId}.ext`, `{username}.ext`, `@{username}.ext`

Not required from the extension. If absent, the viewer returns a fallback SVG.

---

## 6. Accepted Combinations and Excluded Cases

| Case                                                              | Viewer behavior                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Manifest item + mp4 + TXT all present                             | Local files attach to the manifest entry (intended path)                   |
| Manifest item only                                                | `hasLocalMedia: false`; only manifest data shown                           |
| mp4 + TXT exist but no matching manifest item                     | Treated as a standalone `kind: "local-only"` entry (`local:<genId/postId/taskId/stem>`) |
| mp4 only (no TXT)                                                 | Match attempted via stem ID tokens. Promoted if matched, else local-only.  |
| TXT has a `Generation ID` that disagrees with the item            | Score becomes `-1` — **no match**. Falls into local-only.                  |
| JSON file whose name does not start with `soravault_manifest_`    | Ignored by the viewer                                                      |
| Corrupted JSON                                                    | Recorded in `stats.manifestErrors`; other manifests continue to be indexed |
| `sora_v1_*` directories                                           | Not walked by the viewer (Sora 2 only)                                     |

---

## 7. Change-Time Checklist

When changing the output format on the `nomy/chrome extension/` side, verify the contract with the viewer is intact by checking:

- [ ] Manifest file names still match the regex in §2.1
- [ ] Each `items[]` element carries at least one of `genId` / `postId` / `taskId`
- [ ] For v2, `_raw.post` (including `post.attachments[0]`) is preserved
- [ ] The TXT label strings **`Generation ID` / `Task ID` / `Post ID` are unchanged** (the viewer reads `metadata["Generation ID"]` etc. as exact dictionary keys — a single character change breaks it)
- [ ] The body lives below a `Prompt` separator line
- [ ] mp4 and TXT share an identical stem (excluding the extension)
- [ ] ID values keep their prefixes (`gen_`, `task_`, `s_`)
- [ ] Source directory names start with `sora_v2_` (without the `sora_` prefix they are not detected)
- [ ] If `replies[]` is populated, entries are flat, use absolute `parentId` references, and tombstoned posts are excluded (see §2.7). The field may be absent — the viewer must not require it.

After the change, run `npm start` on the viewer side, click `Rescan` in the UI, and confirm that the file shows up in `Loaded manifests` and that local media thumbnails appear in the gallery.

---

## Reference: Related Viewer Sources

| Contract                                  | Source                                               |
| ----------------------------------------- | ---------------------------------------------------- |
| Manifest file name acceptance             | `sora2-vault-viewer/app/indexing/manifest.js:8-14`   |
| `items[]` → entry conversion              | `sora2-vault-viewer/app/indexing/manifest.js:114`    |
| Deduplication key                         | `sora2-vault-viewer/app/indexing/manifest.js:35`     |
| Source directory discovery                | `sora2-vault-viewer/app/server_runtime.js:40`        |
| Local file collection and matching        | `sora2-vault-viewer/app/indexing/local-match.js:248` |
| Matching score computation                | `sora2-vault-viewer/app/indexing/local-match.js:167` |
| TXT parser (metadata + prompt)            | `sora2-vault-viewer/app/indexing/text.js:143`        |
| ID token regular expressions              | `sora2-vault-viewer/app/indexing/common.js:57`       |
| SQLite index schema (v5)                  | `sora2-vault-viewer/app/store.js:47-97`              |
