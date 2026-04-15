const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TMP_PARENT = path.join(ROOT, ".tmp");
fs.mkdirSync(TMP_PARENT, { recursive: true });
const TMP_ROOT = fs.mkdtempSync(path.join(TMP_PARENT, "sora2-viewer-smoke-"));
const DATA_DIR = path.join(TMP_ROOT, "sora2_data");
const PROFILE_DIR = path.join(DATA_DIR, "sora_v2_profile");
const PORT = 33210;

process.env.PORT = String(PORT);
process.env.SORA_DATA_DIR = DATA_DIR;
process.env.SORA_ENABLE_SQLITE_CACHE = "1";
process.env.SORA_SQLITE_PATH = ":memory:";
process.env.SORA_BIND_HOST = "127.0.0.1";

const { startServer } = require(path.join(ROOT, "app", "server.js"));

function writeFixtureData() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const manifest = {
    exported_at: "2026-04-15T00:00:00Z",
    total: 1,
    scan_sources: ["v2_profile"],
    items: [
      {
        source: "v2_profile",
        genId: "gen_smoke123",
        taskId: "task_smoke123",
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
    ],
  };

  fs.writeFileSync(
    path.join(DATA_DIR, "soravault_manifest_smoke.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  fs.writeFileSync(path.join(PROFILE_DIR, "2026-04-15_gen_smoke123.mp4"), "");
  fs.writeFileSync(
    path.join(PROFILE_DIR, "2026-04-15_gen_smoke123.txt"),
    [
      "Source: v2_profile",
      "Generation ID: gen_smoke123",
      "Task ID: task_smoke123",
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

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the smoke-test server to start.")), 15000);
    server.once("listening", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function run() {
  writeFixtureData();
  const server = startServer(PORT);

  try {
    await waitForServer(server);

    const indexResponse = await fetch(`http://127.0.0.1:${PORT}/api/index`);
    assert.equal(indexResponse.status, 200, "Expected /api/index to return 200");
    const indexPayload = await indexResponse.json();
    assert.equal(indexPayload.items.length, 1, "Expected one indexed item");
    assert.equal(indexPayload.items[0].mediaUrl, "/media?id=v2_profile%3Agen_smoke123&kind=media");
    assert.equal(indexPayload.items[0].posterUsername, "smoke_user");
    assert.equal(indexPayload.items[0].localMediaPath, undefined);
    assert.equal(indexPayload.stats.database.enabled, true, "Expected SQLite-backed index metadata");

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

    const dateRangeHitResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/index?dateFrom=${encodeURIComponent("2026-04-15")}&dateTo=${encodeURIComponent("2026-04-15")}`,
    );
    assert.equal(dateRangeHitResponse.status, 200, "Expected date range search to return 200");
    const dateRangeHitPayload = await dateRangeHitResponse.json();
    assert.equal(dateRangeHitPayload.items.length, 1, "Expected the fixture item to match its own date range");

    const dateRangeMissResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/index?dateFrom=${encodeURIComponent("2026-04-16")}`,
    );
    assert.equal(dateRangeMissResponse.status, 200, "Expected out-of-range date search to return 200");
    const dateRangeMissPayload = await dateRangeMissResponse.json();
    assert.equal(dateRangeMissPayload.items.length, 0, "Expected out-of-range date filtering to exclude the fixture item");

    const detailResponse = await fetch(
      `http://127.0.0.1:${PORT}/api/item/${encodeURIComponent(indexPayload.items[0].id)}`,
    );
    assert.equal(detailResponse.status, 200, "Expected /api/item to return 200");
    const detailPayload = await detailResponse.json();
    assert.equal(detailPayload.mediaUrl, "/media?id=v2_profile%3Agen_smoke123&kind=media");
    assert.equal(detailPayload.debug, null, "Expected debug payloads to be hidden by default");
    assert.equal(detailPayload.local.txtRaw.includes("Smoke test prompt"), true);

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
