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
const APP_DATA_DIR = path.join(TMP_ROOT, "app-data");
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

  const manifest = {
    exported_at: "2026-04-15T00:00:00Z",
    total: 5,
    scan_sources: ["v2_profile"],
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
          profile: { username: "smoke_user" },
          post: {
            id: "s_smoke123",
            text: "Smoke test prompt",
            caption: "Manifest only caption",
            like_count: 7,
            view_count: 42,
            attachments: [{ generation_id: "gen_smoke123" }],
            cameo_profiles: [],
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
    path.join(DATA_DIR, "soravault_manifest_smoke.json"),
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
}

function appendRestartFixtureData() {
  const manifestPath = path.join(DATA_DIR, "soravault_manifest_smoke.json");
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

async function fetchIndexPayload(port, query = "") {
  const response = await fetch(`http://127.0.0.1:${port}/api/index${query}`);
  assert.equal(response.status, 200, "Expected /api/index to return 200");
  return response.json();
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
    assert.equal(firstPayload.stats.totalItems, 5, "Expected initial startup to index the fixture manifest");
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
      [5, 6].includes(immediatePayload.stats.totalItems),
      true,
      "Expected restart to return either the cached index immediately or the refreshed index if rebuilding already finished",
    );
    if (immediatePayload.stats.totalItems === 5) {
      assert.equal(
        immediatePayload.indexStatus?.isRefreshing,
        true,
        "Expected cached restart response to advertise background refresh activity",
      );
    }

    const secondPayload = await waitForCondition(async () => {
      const payload = await fetchIndexPayload(PORT);
      return payload.stats.totalItems === 6 ? payload : null;
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

    const indexResponse = await fetch(`http://127.0.0.1:${PORT}/api/index`);
    assert.equal(indexResponse.status, 200, "Expected /api/index to return 200");
    const indexPayload = await indexResponse.json();
    assert.equal(indexPayload.items.length, 6, "Expected all manifest items to remain indexed");
    assert.equal(indexPayload.stats.totalItems, 6, "Expected stats to report all indexed items");
    assert.equal(indexPayload.stats.withLocalMedia, 1, "Expected only one item to match the local media pair");
    assert.equal(indexPayload.stats.database.configured, true, "Expected SQLite cache configuration metadata");
    const mainItem = indexPayload.items.find((item) => item.genId === "gen_smoke123");
    assert(mainItem, "Expected the primary fixture item to be present");
    assert.equal(mainItem.mediaUrl, "/media?id=v2_profile%3Agen_smoke123&kind=media");
    assert.equal(mainItem.posterUsername, "smoke_user");
    assert.equal(mainItem.localMediaPath, undefined);
    const ambiguousItem = indexPayload.items.find((item) => item.genId === "gen_other999");
    assert(ambiguousItem, "Expected the ambiguous task fixture item to be present");
    assert.equal(ambiguousItem.hasLocalMedia, false, "Expected shared task IDs not to attach the wrong local media");
    const fallbackItems = indexPayload.items.filter((item) => item.prompt.startsWith("Fallback manifest"));
    assert.equal(fallbackItems.length, 2, "Expected identifier-less manifest items not to overwrite each other");
    for (const item of fallbackItems) {
      assert.equal(item.id.includes("undefined"), false, "Expected fallback manifest IDs to be stable");
    }

    const manifestSearchResponse = await fetch(`http://127.0.0.1:${PORT}/api/index?query=caption`);
    assert.equal(manifestSearchResponse.status, 200, "Expected manifest search to return 200");
    const manifestSearchPayload = await manifestSearchResponse.json();
    assert.equal(manifestSearchPayload.items.length, 1, "Expected manifest-only metadata to be searchable");

    const usernamePrefixSearchResponse = await fetch(`http://127.0.0.1:${PORT}/api/index?query=%40smoke`);
    assert.equal(usernamePrefixSearchResponse.status, 200, "Expected @username prefix search to return 200");
    const usernamePrefixSearchPayload = await usernamePrefixSearchResponse.json();
    assert.equal(usernamePrefixSearchPayload.items.length, 1, "Expected @username prefix search to match manifest usernames");

    const usernameNonPrefixSearchResponse = await fetch(`http://127.0.0.1:${PORT}/api/index?query=%40user`);
    assert.equal(usernameNonPrefixSearchResponse.status, 200, "Expected non-prefix @username search to return 200");
    const usernameNonPrefixSearchPayload = await usernameNonPrefixSearchResponse.json();
    assert.equal(usernameNonPrefixSearchPayload.items.length, 0, "Expected non-prefix @username search not to match manifest usernames");

    const literalAtSearchResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/index?query=${encodeURIComponent("@smoke marker")}`,
    );
    assert.equal(literalAtSearchResponse.status, 200, "Expected spaced @ query to return 200");
    const literalAtSearchPayload = await literalAtSearchResponse.json();
    assert.equal(literalAtSearchPayload.items.length, 1, "Expected spaced @ query to use simple text search");
    assert.equal(literalAtSearchPayload.items[0].prompt, "Literal @smoke marker");

    const fallbackSearchResponse = await fetch(`http://127.0.0.1:${PORT}/api/index?query=${encodeURIComponent("Fallback manifest")}`);
    assert.equal(fallbackSearchResponse.status, 200, "Expected fallback prompt search to return 200");
    const fallbackSearchPayload = await fallbackSearchResponse.json();
    assert.equal(fallbackSearchPayload.items.length, 2, "Expected both identifier-less manifest items to be searchable");

    const dateRangeHitResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/index?dateFrom=${encodeURIComponent("2026-04-15")}&dateTo=${encodeURIComponent("2026-04-15")}`,
    );
    assert.equal(dateRangeHitResponse.status, 200, "Expected date range search to return 200");
    const dateRangeHitPayload = await dateRangeHitResponse.json();
    assert.equal(dateRangeHitPayload.items.length, 1, "Expected the fixture item to match its own date range");

    const dateRangeMissResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/index?dateFrom=${encodeURIComponent("2026-04-18")}`,
    );
    assert.equal(dateRangeMissResponse.status, 200, "Expected out-of-range date search to return 200");
    const dateRangeMissPayload = await dateRangeMissResponse.json();
    assert.equal(dateRangeMissPayload.items.length, 0, "Expected out-of-range date filtering to exclude the fixture item");

    const detailResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/item/${encodeURIComponent(mainItem.id)}`,
    );
    assert.equal(detailResponse.status, 200, "Expected /api/item to return 200");
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.mediaUrl, "/media?id=v2_profile%3Agen_smoke123&kind=media");
    assert.equal(detailPayload.debug, null, "Expected debug payloads to be hidden by default");
    assert.equal(detailPayload.local.txtRaw.includes("Smoke test prompt"), true);
    assert.equal(fs.existsSync(path.join(APP_DATA_DIR, "txt-record-cache.json")), true, "Expected TXT cache file to be created");

    const ambiguousDetailResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/item/${encodeURIComponent(ambiguousItem.id)}`,
    );
    assert.equal(ambiguousDetailResponse.status, 200, "Expected the ambiguous task fixture detail to load");
    const ambiguousDetailPayload = await ambiguousDetailResponse.json();
    assert.equal(ambiguousDetailPayload.mediaUrl, null, "Expected the ambiguous task fixture not to inherit the local media URL");

    const mediaResponse = await fetch(`http://127.0.0.1:${PORT}${detailPayload.mediaUrl}`);
    assert.equal(mediaResponse.status, 200, "Expected /media to return 200");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {}
  }
}

run().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
