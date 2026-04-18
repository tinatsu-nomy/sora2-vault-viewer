const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TMP_PARENT = path.join(ROOT, ".tmp");
fs.mkdirSync(TMP_PARENT, { recursive: true });
const TMP_ROOT = fs.mkdtempSync(path.join(TMP_PARENT, "sora2-viewer-smoke-"));
const DATA_DIR = path.join(TMP_ROOT, "sora2_data");
const PROFILE_DIR = path.join(DATA_DIR, "sora_v2_profile");
const LIKED_DIR = path.join(DATA_DIR, "sora_v2_liked");
const CAMEOS_DIR = path.join(DATA_DIR, "sora_v2_cameos");
const CAMEOS_DRAFT_DIR = path.join(DATA_DIR, "sora_v2_cameo_drafts");
const USER_DIR = path.join(DATA_DIR, "sora_v2_@bucket_user");
const CHAR_DIR = path.join(DATA_DIR, "sora_v2_char_@sparklecat");
const CHAR_DRAFT_DIR = path.join(DATA_DIR, "sora_v2_char_drafts_@sparklecat");
const CHARACTER_DIR = path.join(DATA_DIR, "sora_characters_@smoke_user");
const APP_DATA_DIR = path.join(TMP_ROOT, "app-data");
const MANIFEST_FILE_NAME = "soravault_manifest_merged_2026-04-18_102546_part01.json";
const PORT = 33210;
const RETRY_PORT = 33230;

process.env.PORT = String(PORT);
process.env.SORA_DATA_DIR = DATA_DIR;
process.env.SORA_ENABLE_SQLITE_CACHE = "1";
process.env.SORA_BIND_HOST = "127.0.0.1";
process.env.SORA_APP_DATA_DIR = APP_DATA_DIR;

function loadStartServer({ dbPath } = {}) {
  process.env.SORA_SQLITE_PATH = dbPath;
  const serverPath = path.join(ROOT, "app", "server.js");
  const runtimePath = path.join(ROOT, "app", "server_runtime.js");
  delete require.cache[require.resolve(serverPath)];
  delete require.cache[require.resolve(runtimePath)];
  return require(serverPath).startServer;
}

function writeFixtureData() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(LIKED_DIR, { recursive: true });
  fs.mkdirSync(CAMEOS_DIR, { recursive: true });
  fs.mkdirSync(CAMEOS_DRAFT_DIR, { recursive: true });
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(CHAR_DIR, { recursive: true });
  fs.mkdirSync(CHAR_DRAFT_DIR, { recursive: true });
  fs.mkdirSync(CHARACTER_DIR, { recursive: true });

  const manifest = {
    exported_at: "2026-04-15T00:00:00Z",
    total: 7,
    scan_sources: ["v2_profile", "v2_liked", "v2_user"],
    items: [
      {
        source: "v2_profile",
        genId: "gen_smoke123",
        taskId: "task_shared",
        postId: "s_smoke123",
        date: "2026-04-15",
        prompt: "Smoke test prompt",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 5,
        isLiked: true,
        _raw: {
          profile: { username: "smoke_user", user_id: "user-smoke" },
          post: {
            id: "s_smoke123",
            text: "Smoke test prompt",
            caption: "Manifest only caption",
            like_count: 7,
            view_count: 42,
            attachments: [{ generation_id: "gen_smoke123" }],
            cameo_profiles: [
              { username: "cameo.source.hero", user_id: "user-cameo-hero" },
            ],
          },
        },
      },
      {
        source: "v2_liked",
        genId: "gen_smoke123",
        taskId: "task_shared",
        postId: "s_smoke123",
        date: "2026-04-15",
        prompt: "Smoke test prompt",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 5,
        isLiked: true,
        _raw: {
          profile: { username: "smoke_user", user_id: "user-smoke" },
          post: {
            id: "s_smoke123",
            text: "Smoke test prompt",
            caption: "Manifest only caption",
            like_count: 7,
            view_count: 42,
            attachments: [{ generation_id: "gen_smoke123" }],
            cameo_profiles: [
              { username: "cameo.source.hero", user_id: "user-cameo-hero" },
            ],
          },
        },
      },
      {
        source: "v2_profile",
        genId: "gen_other999",
        taskId: "task_shared",
        postId: "s_other999",
        date: "2026-04-14",
        prompt: "Ambiguous task item",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 6,
        isLiked: false,
        _raw: {
          profile: { username: "other_user" },
          post: {
            id: "s_other999",
            text: "Ambiguous task item",
            like_count: 1,
            view_count: 3,
            attachments: [{ generation_id: "gen_other999" }],
            cameo_profiles: [],
          },
        },
      },
      {
        source: "v2_liked",
        genId: "gen_user999",
        taskId: "task_user999",
        postId: "s_user999",
        date: "2026-04-10",
        prompt: "Bucket user shared item",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 7,
        isLiked: true,
        _raw: {
          profile: { username: "bucket_user", user_id: "user-bucket" },
          post: {
            id: "s_user999",
            text: "Bucket user shared item",
            like_count: 5,
            view_count: 9,
            attachments: [{ generation_id: "gen_user999" }],
            cameo_profiles: [],
          },
        },
      },
      {
        source: "v2_user",
        genId: "gen_user999",
        taskId: "task_user999",
        postId: "s_user999",
        date: "2026-04-10",
        prompt: "Bucket user shared item",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 7,
        isLiked: false,
        _raw: {
          profile: { username: "bucket_user", user_id: "user-bucket" },
          post: {
            id: "s_user999",
            text: "Bucket user shared item",
            like_count: 5,
            view_count: 9,
            attachments: [{ generation_id: "gen_user999" }],
            cameo_profiles: [],
          },
        },
      },
      {
        source: "v2_profile",
        date: "2026-04-13",
        prompt: "Fallback manifest alpha",
        _raw: {
          profile: { username: "fallback_alpha" },
          post: {
            text: "Fallback manifest alpha",
            cameo_profiles: [],
          },
        },
      },
      {
        source: "v2_profile",
        date: "2026-04-12",
        prompt: "Literal @smoke marker",
        _raw: {
          profile: { username: "literal_marker" },
          post: {
            text: "Literal @smoke marker",
            cameo_profiles: [],
          },
        },
      },
      {
        source: "v2_profile",
        date: "2026-04-11",
        prompt: "Fallback manifest beta",
        _raw: {
          profile: { username: "fallback_beta" },
          post: {
            text: "Fallback manifest beta",
            cameo_profiles: [],
          },
        },
      },
    ],
  };

  fs.writeFileSync(
    path.join(DATA_DIR, MANIFEST_FILE_NAME),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  fs.writeFileSync(
    path.join(PROFILE_DIR, "2026-04-15_gen_smoke123.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(PROFILE_DIR, "2026-04-15_gen_smoke123.txt"),
    [
      "Source: v2_profile",
      "Generation ID: gen_smoke123",
      "Task ID: task_shared",
      "Post ID: s_smoke123",
      "Date: 2026-04-15",
      "Duration: 5",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: yes",
      "Prompt",
      "Smoke test prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(CAMEOS_DIR, "2026-04-09_gen_cameo111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(CAMEOS_DIR, "2026-04-09_gen_cameo111.txt"),
    [
      "Source: v2_cameos",
      "Generation ID: gen_cameo111",
      "Task ID: task_cameo111",
      "Post ID: s_cameo111",
      "Date: 2026-04-09",
      "Duration: 8",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Cameos source prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(CAMEOS_DRAFT_DIR, "2026-04-08_gen_cameodraft111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(CAMEOS_DRAFT_DIR, "2026-04-08_gen_cameodraft111.txt"),
    [
      "Source: v2_cameo_drafts",
      "Generation ID: gen_cameodraft111",
      "Task ID: task_cameodraft111",
      "Post ID: s_cameodraft111",
      "Date: 2026-04-08",
      "Duration: 3",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Cameos drafts prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(USER_DIR, "2026-04-10_gen_user999.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(USER_DIR, "2026-04-10_gen_user999.txt"),
    [
      "Source: v2_user",
      "Generation ID: gen_user999",
      "Task ID: task_user999",
      "Post ID: s_user999",
      "Date: 2026-04-10",
      "Duration: 7",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Bucket user shared item",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(CHAR_DIR, "2026-04-11_gen_char111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(CHAR_DIR, "2026-04-11_gen_char111.txt"),
    [
      "Source: v2_char_@sparklecat",
      "Generation ID: gen_char111",
      "Task ID: task_char111",
      "Post ID: s_char111",
      "Date: 2026-04-11",
      "Duration: 6",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Character source prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(CHAR_DRAFT_DIR, "2026-04-12_gen_chardraft111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(CHAR_DRAFT_DIR, "2026-04-12_gen_chardraft111.txt"),
    [
      "Source: v2_char_drafts_@sparklecat",
      "Generation ID: gen_chardraft111",
      "Task ID: task_chardraft111",
      "Post ID: s_chardraft111",
      "Date: 2026-04-12",
      "Duration: 4",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Character drafts prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(CHARACTER_DIR, "owner_cameo.source.hero_Friendly_Hero.jpg"),
    Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  );
}

function appendRestartFixtureData() {
  const manifestPath = path.join(DATA_DIR, MANIFEST_FILE_NAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.total += 1;
  manifest.items.push({
    source: "v2_profile",
    genId: "gen_after_restart",
    postId: "s_after_restart",
    date: "2026-04-17",
    prompt: "Loaded after restart",
    _raw: {
      profile: { username: "restart_user" },
      post: {
        id: "s_after_restart",
        text: "Loaded after restart",
        cameo_profiles: [],
        attachments: [{ generation_id: "gen_after_restart" }],
      },
    },
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

function waitForServer(server, { rejectOnError = true } = {}) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the smoke-test server to start."));
    }, 15000);
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      server.off("listening", onListening);
      if (rejectOnError) server.off("error", onError);
    };
    server.on("listening", onListening);
    if (rejectOnError) server.on("error", onError);
  });
}

function request(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      agent: false,
      headers: {
        Connection: "close",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
  });
}

async function requestJson(url, message) {
  const response = await request(url);
  assert.equal(response.status, 200, message);
  return JSON.parse(response.body);
}

async function fetchIndexPayload(port, query = "") {
  return requestJson(`http://127.0.0.1:${port}/api/index${query}`, "Expected /api/index to return 200");
}

async function waitForCondition(check, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for the expected condition.");
}

async function assertPortRetryWorks() {
  const startServer = loadStartServer({ dbPath: path.join(TMP_ROOT, "retry.sqlite") });
  const blocker = http.createServer((_request, response) => {
    response.end("busy");
  });

  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(RETRY_PORT, "127.0.0.1", resolve);
  });

  const retriedServer = startServer(RETRY_PORT);
  try {
    await waitForServer(retriedServer, { rejectOnError: false });
    const address = retriedServer.address();
    const actualPort = typeof address === "object" && address ? address.port : null;
    assert.equal(actualPort, RETRY_PORT + 1, "Expected the returned server to retry on the next port");
  } finally {
    await new Promise((resolve) => retriedServer.close(resolve));
    await new Promise((resolve) => blocker.close(resolve));
  }
}

async function assertRestartRefreshesCachedIndex() {
  const restartDbPath = path.join(TMP_ROOT, "restart.sqlite");
  const firstStartServer = loadStartServer({ dbPath: restartDbPath });
  const firstServer = firstStartServer(PORT);

  try {
    await waitForServer(firstServer);
    const firstPayload = await fetchIndexPayload(PORT);
    assert.equal(firstPayload.stats.totalItems, 10, "Expected initial startup to index the fixture manifest and local-only char/cameos sources");
  } finally {
    await new Promise((resolve) => firstServer.close(resolve));
  }

  appendRestartFixtureData();

  const secondStartServer = loadStartServer({ dbPath: restartDbPath });
  const secondServer = secondStartServer(PORT);
  try {
    await waitForServer(secondServer);
    const immediatePayload = await fetchIndexPayload(PORT);
    assert.equal(
      [10, 11].includes(immediatePayload.stats.totalItems),
      true,
      "Expected restart to return either the cached index immediately or the refreshed index if rebuilding already finished",
    );
    if (immediatePayload.stats.totalItems === 10) {
      assert.equal(
        immediatePayload.indexStatus?.isRefreshing,
        true,
        "Expected cached restart response to advertise background refresh activity",
      );
    }

    const secondPayload = await waitForCondition(async () => {
      const payload = await fetchIndexPayload(PORT);
      return payload.stats.totalItems === 11 ? payload : null;
    });
    assert(
      secondPayload.items.some((item) => item.genId === "gen_after_restart"),
      "Expected restart rebuild to include the newly added manifest item",
    );
  } finally {
    await new Promise((resolve) => secondServer.close(resolve));
  }
}

async function run() {
  writeFixtureData();
  await assertPortRetryWorks();
  await assertRestartRefreshesCachedIndex();
  const startServer = loadStartServer({ dbPath: path.join(TMP_ROOT, "main.sqlite") });
  const server = startServer(PORT);

  try {
    await waitForServer(server);

    const indexPayload = await requestJson(`http://127.0.0.1:${PORT}/api/index`, "Expected /api/index to return 200");
    assert.equal(indexPayload.items.length, 11, "Expected all manifest and local-only fixture items to remain indexed");
    assert.equal(indexPayload.stats.totalItems, 11, "Expected stats to report all indexed items");
    assert.equal(indexPayload.stats.withLocalMedia, 6, "Expected merged items plus char and cameos sources to match local media pairs");
    assert.equal(indexPayload.stats.database.configured, true, "Expected SQLite cache configuration metadata");
    assert(indexPayload.stats.sourceOrder.includes("v2_cameos"), "Expected cameos sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_cameo_drafts"), "Expected cameos draft sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_char_@sparklecat"), "Expected char sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_char_drafts_@sparklecat"), "Expected char draft sources to be included in source order");
    const mainItem = indexPayload.items.find((item) => item.genId === "gen_smoke123");
    assert(mainItem, "Expected the primary fixture item to be present");
    assert.equal(mainItem.mediaUrl, "/media?id=gen_smoke123&kind=media");
    assert.equal(mainItem.posterUsername, "smoke_user");
    assert.deepEqual(mainItem.sourceMemberships, ["v2_profile", "v2_liked"]);
    assert.equal(mainItem.localMediaPath, undefined);
    const ambiguousItem = indexPayload.items.find((item) => item.genId === "gen_other999");
    assert(ambiguousItem, "Expected the ambiguous task fixture item to be present");
    assert.equal(ambiguousItem.hasLocalMedia, false, "Expected shared task IDs not to attach the wrong local media");
    const sharedUserItem = indexPayload.items.find((item) => item.genId === "gen_user999");
    assert(sharedUserItem, "Expected the liked/user shared fixture item to be present");
    assert.deepEqual(sharedUserItem.sourceMemberships, ["v2_liked", "v2_@bucket_user"]);
    assert.equal(sharedUserItem.hasLocalMedia, true, "Expected the custom user directory to attach local media");
    const fallbackItems = indexPayload.items.filter((item) => item.prompt.startsWith("Fallback manifest"));
    assert.equal(fallbackItems.length, 2, "Expected identifier-less manifest items not to overwrite each other");
    for (const item of fallbackItems) {
      assert.equal(item.id.includes("undefined"), false, "Expected fallback manifest IDs to be stable");
    }

    const manifestSearchPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?query=caption`,
      "Expected manifest search to return 200",
    );
    assert.equal(manifestSearchPayload.items.length, 1, "Expected manifest-only metadata to be searchable");

    const usernamePrefixSearchPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?query=%40smoke`,
      "Expected @username prefix search to return 200",
    );
    assert.equal(usernamePrefixSearchPayload.items.length, 1, "Expected @username prefix search to match manifest usernames");

    const usernameNonPrefixSearchPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?query=%40user`,
      "Expected non-prefix @username search to return 200",
    );
    assert.equal(usernameNonPrefixSearchPayload.items.length, 0, "Expected non-prefix @username search not to match manifest usernames");

    const literalAtSearchPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?query=${encodeURIComponent("@smoke marker")}`,
      "Expected spaced @ query to return 200",
    );
    assert.equal(literalAtSearchPayload.items.length, 1, "Expected spaced @ query to use simple text search");
    assert.equal(literalAtSearchPayload.items[0].prompt, "Literal @smoke marker");

    const profileFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_profile`,
      "Expected profile filter search to return 200",
    );
    assert.equal(profileFilterPayload.items.some((item) => item.genId === "gen_smoke123"), true, "Expected shared profile/liked item to appear in profile filter");
    assert.equal(profileFilterPayload.items.some((item) => item.genId === "gen_user999"), false, "Expected liked/user item not to appear in profile filter");

    const likedFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_liked`,
      "Expected liked filter search to return 200",
    );
    assert.equal(likedFilterPayload.items.some((item) => item.genId === "gen_smoke123"), true, "Expected shared profile/liked item to appear in liked filter");
    assert.equal(likedFilterPayload.items.some((item) => item.genId === "gen_user999"), true, "Expected shared liked/user item to appear in liked filter");

    const userFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_@bucket_user")}`,
      "Expected custom user filter search to return 200",
    );
    assert.equal(userFilterPayload.items.length, 1, "Expected only the shared liked/user item to appear in custom user filter");
    assert.equal(userFilterPayload.items[0].genId, "gen_user999");

    const charFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_char_@sparklecat")}`,
      "Expected char source filter search to return 200",
    );
    assert.equal(charFilterPayload.items.length, 1, "Expected only the char local-only item to appear in char source filter");
    assert.equal(charFilterPayload.items[0].genId, "gen_char111");

    const charDraftFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_char_drafts_@sparklecat")}`,
      "Expected char drafts filter search to return 200",
    );
    assert.equal(charDraftFilterPayload.items.length, 1, "Expected only the char draft local-only item to appear in char drafts filter");
    assert.equal(charDraftFilterPayload.items[0].genId, "gen_chardraft111");

    const cameosFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_cameos`,
      "Expected cameos filter search to return 200",
    );
    assert.equal(cameosFilterPayload.items.length, 1, "Expected only the cameos local-only item to appear in cameos filter");
    assert.equal(cameosFilterPayload.items[0].genId, "gen_cameo111");

    const cameosDraftFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_cameo_drafts`,
      "Expected cameos drafts filter search to return 200",
    );
    assert.equal(cameosDraftFilterPayload.items.length, 1, "Expected only the cameos draft local-only item to appear in cameos drafts filter");
    assert.equal(cameosDraftFilterPayload.items[0].genId, "gen_cameodraft111");

    const mergedFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_profile,v2_liked`,
      "Expected merged source filter search to return 200",
    );
    assert.equal(mergedFilterPayload.items.filter((item) => item.genId === "gen_smoke123").length, 1, "Expected shared items to stay deduped across multiple selected filters");

    const fallbackSearchPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?query=${encodeURIComponent("Fallback manifest")}`,
      "Expected fallback prompt search to return 200",
    );
    assert.equal(fallbackSearchPayload.items.length, 2, "Expected both identifier-less manifest items to be searchable");

    const dateRangeHitPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?dateFrom=${encodeURIComponent("2026-04-15")}&dateTo=${encodeURIComponent("2026-04-15")}`,
      "Expected date range search to return 200",
    );
    assert.equal(dateRangeHitPayload.items.length, 1, "Expected the fixture item to match its own date range");

    const dateRangeMissPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?dateFrom=${encodeURIComponent("2026-04-18")}`,
      "Expected out-of-range date search to return 200",
    );
    assert.equal(dateRangeMissPayload.items.length, 0, "Expected out-of-range date filtering to exclude the fixture item");

    const detailPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/item/${encodeURIComponent(mainItem.id)}`,
      "Expected /api/item to return 200",
    );
    assert.equal(detailPayload.mediaUrl, "/media?id=gen_smoke123&kind=media");
    assert.equal(detailPayload.debug, null, "Expected debug payloads to be hidden by default");
    assert.equal(detailPayload.local.txtRaw.includes("Smoke test prompt"), true);
    assert.equal(detailPayload.cameoProfiles.length, 1, "Expected cameo profile metadata to be preserved");
    assert.equal(detailPayload.cameoProfiles[0].username, "cameo.source.hero");
    assert.equal(fs.existsSync(path.join(APP_DATA_DIR, "txt-record-cache.json")), true, "Expected TXT cache file to be created");

    const ambiguousDetailPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/item/${encodeURIComponent(ambiguousItem.id)}`,
      "Expected the ambiguous task fixture detail to load",
    );
    assert.equal(ambiguousDetailPayload.mediaUrl, null, "Expected the ambiguous task fixture not to inherit the local media URL");

    const mediaResponse = await request(`http://127.0.0.1:${PORT}${detailPayload.mediaUrl}`);
    assert.equal(mediaResponse.status, 200, "Expected /media to return 200");

    const cameoAvatarResponse = await request(
      `http://127.0.0.1:${PORT}/avatar?id=${encodeURIComponent(mainItem.id)}&role=cameo&username=${encodeURIComponent("cameo.source.hero")}`,
    );
    assert.equal(cameoAvatarResponse.status, 200, "Expected /avatar to resolve cameo avatars from owner_<cameo username> fallback files");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
