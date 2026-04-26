const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TMP_PARENT = path.join(ROOT, ".tmp");
fs.mkdirSync(TMP_PARENT, { recursive: true });
const TMP_ROOT = fs.mkdtempSync(path.join(TMP_PARENT, "sora2-viewer-smoke-"));
const DATA_DIR = path.join(TMP_ROOT, "sora2_data");
const LINK_TARGETS_DIR = path.join(TMP_ROOT, "linked-data");
const PROFILE_DIR = path.join(DATA_DIR, "sora_v2_profile");
const LIKED_DIR = path.join(DATA_DIR, "sora_v2_liked");
const CAMEOS_DIR = path.join(DATA_DIR, "sora_v2_cameos");
const CAMEOS_DRAFT_DIR = path.join(DATA_DIR, "sora_v2_cameo_drafts");
const REAL_CAMEOS_DIR = path.join(LINK_TARGETS_DIR, "sora_v2_cameos");
const REAL_CAMEOS_DRAFT_DIR = path.join(LINK_TARGETS_DIR, "sora_v2_cameo_drafts");
const USER_DIR = path.join(DATA_DIR, "sora_v2_@bucket_user");
const CREATORS_DIR = path.join(DATA_DIR, "sora_v2_creators");
const NESTED_USER_DIR = path.join(CREATORS_DIR, "nested_creator");
const NESTED_CHAR_POSTS_DIR = path.join(CREATORS_DIR, "nested_owner", "characters", "nestedcat", "posts");
const CHAR_DIR = path.join(DATA_DIR, "sora_v2_char_@sparklecat");
const CHAR_DRAFT_DIR = path.join(DATA_DIR, "sora_v2_char_drafts_@sparklecat");
const REMIX_ROOT_DIR = path.join(DATA_DIR, "sora_v2_remixes");
const REMIX_CHILDREN_DIR = path.join(REMIX_ROOT_DIR, "downstream", "s_root_smoke111");
const REMIX_PARENTS_DIR = path.join(REMIX_ROOT_DIR, "parents", "remix_parent_user");
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

function loadStartServer({ dbPath, renewOnStart = false } = {}) {
  process.env.SORA_SQLITE_PATH = dbPath;
  process.env.SORA_SQLITE_RENEW_ON_START = renewOnStart ? "1" : "0";
  const serverPath = path.join(ROOT, "app", "server.js");
  const runtimePath = path.join(ROOT, "app", "server_runtime.js");
  delete require.cache[require.resolve(serverPath)];
  delete require.cache[require.resolve(runtimePath)];
  return require(serverPath).startServer;
}

function createDirectoryLink(targetDir, linkPath) {
  fs.symlinkSync(targetDir, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function baseFixtureManifest() {
  return {
    exported_at: "2026-04-15T00:00:00Z",
    total: 11,
    scan_sources: ["v2_profile", "v2_liked", "v2_user", "v2_remix_children", "v2_remix_parents"],
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
          profile: {
            username: "smoke_user",
            user_id: "user-smoke",
            display_name: "Smoke User",
            description: "Primary smoke profile description.",
          },
          post: {
            id: "s_smoke123",
            text: "Smoke test prompt",
            caption: "Manifest only caption",
            like_count: 7,
            view_count: 42,
            attachments: [{ generation_id: "gen_smoke123" }],
            cameo_profiles: [
              {
                username: "cameo.source.hero",
                user_id: "user-cameo-hero",
                display_name: "Friendly Hero",
                description: "Friendly cameo hero description.",
              },
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
          profile: {
            username: "smoke_user",
            user_id: "user-smoke",
            display_name: "Smoke User",
            description: "Primary smoke profile description.",
          },
          post: {
            id: "s_smoke123",
            text: "Smoke test prompt",
            caption: "Manifest only caption",
            like_count: 7,
            view_count: 42,
            attachments: [{ generation_id: "gen_smoke123" }],
            cameo_profiles: [
              {
                username: "cameo.source.hero",
                user_id: "user-cameo-hero",
                display_name: "Friendly Hero",
                description: "Friendly cameo hero description.",
              },
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
        source: "v2_remix_children",
        genId: "gen_remixchild111",
        taskId: "task_remixchild111",
        postId: "s_remixchild111",
        date: "2026-04-09",
        prompt: "Nested remix child prompt",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 8,
        isLiked: false,
        _raw: {
          profile: { username: "remix_child_user", user_id: "user-remix-child" },
          post: {
            id: "s_remixchild111",
            text: "Nested remix child prompt",
            like_count: 2,
            view_count: 6,
            attachments: [{ generation_id: "gen_remixchild111" }],
            cameo_profiles: [],
          },
        },
      },
      {
        source: "v2_remix_parents",
        genId: "gen_remixparent111",
        taskId: "task_remixparent111",
        postId: "s_remixparent111",
        date: "2026-04-08",
        prompt: "Nested remix parent prompt",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 9,
        isLiked: false,
        _raw: {
          profile: { username: "remix_parent_user", user_id: "user-remix-parent" },
          post: {
            id: "s_remixparent111",
            text: "Nested remix parent prompt",
            like_count: 4,
            view_count: 11,
            attachments: [{ generation_id: "gen_remixparent111" }],
            cameo_profiles: [],
          },
        },
      },
      {
        source: "v2_user",
        genId: "gen_nestedcreator111",
        taskId: "task_nestedcreator111",
        postId: "s_nestedcreator111",
        date: "2026-04-07",
        prompt: "Nested creator manifest prompt",
        width: 720,
        height: 1280,
        ratio: "9:16",
        duration: 10,
        isLiked: false,
        _raw: {
          profile: { username: "nested_creator", user_id: "user-nested-creator" },
          post: {
            id: "s_nestedcreator111",
            text: "Nested creator manifest prompt",
            like_count: 8,
            view_count: 21,
            attachments: [{ generation_id: "gen_nestedcreator111" }],
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
}

function resetFixtureManifest() {
  fs.writeFileSync(
    path.join(DATA_DIR, MANIFEST_FILE_NAME),
    JSON.stringify(baseFixtureManifest(), null, 2),
    "utf8",
  );
}

function writeFixtureData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LINK_TARGETS_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(LIKED_DIR, { recursive: true });
  fs.mkdirSync(REAL_CAMEOS_DIR, { recursive: true });
  fs.mkdirSync(REAL_CAMEOS_DRAFT_DIR, { recursive: true });
  createDirectoryLink(REAL_CAMEOS_DIR, CAMEOS_DIR);
  createDirectoryLink(REAL_CAMEOS_DRAFT_DIR, CAMEOS_DRAFT_DIR);
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.mkdirSync(NESTED_USER_DIR, { recursive: true });
  fs.mkdirSync(NESTED_CHAR_POSTS_DIR, { recursive: true });
  fs.mkdirSync(CHAR_DIR, { recursive: true });
  fs.mkdirSync(CHAR_DRAFT_DIR, { recursive: true });
  fs.mkdirSync(REMIX_CHILDREN_DIR, { recursive: true });
  fs.mkdirSync(REMIX_PARENTS_DIR, { recursive: true });
  fs.mkdirSync(CHARACTER_DIR, { recursive: true });

  resetFixtureManifest();

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
    path.join(LIKED_DIR, "2026-04-15_gen_smoke123.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(LIKED_DIR, "2026-04-15_gen_smoke123.txt"),
    [
      "Source: v2_liked",
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
    path.join(REAL_CAMEOS_DIR, "2026-04-09_gen_cameo111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(REAL_CAMEOS_DIR, "2026-04-09_gen_cameo111.txt"),
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
    path.join(REAL_CAMEOS_DRAFT_DIR, "2026-04-08_gen_cameodraft111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(REAL_CAMEOS_DRAFT_DIR, "2026-04-08_gen_cameodraft111.txt"),
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
    path.join(NESTED_USER_DIR, "2026-04-07_gen_nestedcreator111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(NESTED_USER_DIR, "2026-04-07_gen_nestedcreator111.txt"),
    [
      "Source: v2_user",
      "Generation ID: gen_nestedcreator111",
      "Task ID: task_nestedcreator111",
      "Post ID: s_nestedcreator111",
      "Date: 2026-04-07",
      "Duration: 10",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Nested creator manifest prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(NESTED_CHAR_POSTS_DIR, "2026-04-06_gen_nestedchar111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(NESTED_CHAR_POSTS_DIR, "2026-04-06_gen_nestedchar111.txt"),
    [
      "Source: v2_char_posts",
      "Generation ID: gen_nestedchar111",
      "Task ID: task_nestedchar111",
      "Post ID: s_nestedchar111",
      "Date: 2026-04-06",
      "Duration: 6",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Nested creator char prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(REMIX_CHILDREN_DIR, "2026-04-09_gen_remixchild111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(REMIX_CHILDREN_DIR, "2026-04-09_gen_remixchild111.txt"),
    [
      "Source: v2_remix_children",
      "Generation ID: gen_remixchild111",
      "Task ID: task_remixchild111",
      "Post ID: s_remixchild111",
      "Date: 2026-04-09",
      "Duration: 8",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Nested remix child prompt",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(REMIX_PARENTS_DIR, "2026-04-08_gen_remixparent111.mp4"),
    Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
  );
  fs.writeFileSync(
    path.join(REMIX_PARENTS_DIR, "2026-04-08_gen_remixparent111.txt"),
    [
      "Source: v2_remix_parents",
      "Generation ID: gen_remixparent111",
      "Task ID: task_remixparent111",
      "Post ID: s_remixparent111",
      "Date: 2026-04-08",
      "Duration: 9",
      "Resolution: 720x1280",
      "Aspect ratio: 9:16",
      "Liked: no",
      "Prompt",
      "Nested remix parent prompt",
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

function appendRenewFixtureData() {
  const manifestPath = path.join(DATA_DIR, MANIFEST_FILE_NAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.total += 1;
  manifest.items.push({
    source: "v2_profile",
    genId: "gen_after_renew",
    postId: "s_after_renew",
    date: "2026-04-18",
    prompt: "Loaded after renew",
    _raw: {
      profile: { username: "renew_user" },
      post: {
        id: "s_after_renew",
        text: "Loaded after renew",
        cameo_profiles: [],
        attachments: [{ generation_id: "gen_after_renew" }],
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

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method: options.method || "GET",
      agent: false,
      headers: {
        Connection: "close",
        ...(options.headers || {}),
      },
    };
    const req = http.request(url, requestOptions, (response) => {
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
    if (options.body) {
      req.write(options.body);
    }
    req.end();
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

async function assertRestartUsesCachedIndexUntilRebuild() {
  const restartDbPath = path.join(TMP_ROOT, "restart.sqlite");
  const firstStartServer = loadStartServer({ dbPath: restartDbPath });
  const firstServer = firstStartServer(PORT);

  try {
    await waitForServer(firstServer);
    const firstPayload = await fetchIndexPayload(PORT);
    assert.equal(firstPayload.stats.totalItems, 14, "Expected initial startup to index the fixture manifest and local-only char/cameos sources");
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
      [14, 15].includes(immediatePayload.stats.totalItems),
      true,
      "Expected restart to return either the cached index or a fully rebuilt index",
    );
    if (immediatePayload.stats.totalItems === 14) {
      assert.equal(
        immediatePayload.indexStatus?.isRefreshing,
        false,
        "Expected cached restart response to avoid automatic background refresh",
      );
    }

    const rebuildResponse = await request(`http://127.0.0.1:${PORT}/api/rebuild`, { method: "POST" });
    assert.equal(rebuildResponse.status, 200, "Expected /api/rebuild to return 200 after restart");

    const secondPayload = await waitForCondition(async () => {
      const payload = await fetchIndexPayload(PORT);
      return payload.stats.totalItems === 15 ? payload : null;
    });
    assert(
      secondPayload.items.some((item) => item.genId === "gen_after_restart"),
      "Expected restart rebuild to include the newly added manifest item",
    );
  } finally {
    await new Promise((resolve) => secondServer.close(resolve));
  }
}

async function assertRenewOnStartForcesFreshRebuild() {
  const renewDbPath = path.join(TMP_ROOT, "renew.sqlite");
  const firstStartServer = loadStartServer({ dbPath: renewDbPath });
  const firstServer = firstStartServer(PORT);

  try {
    await waitForServer(firstServer);
    const firstPayload = await fetchIndexPayload(PORT);
    assert.equal(firstPayload.stats.totalItems, 15, "Expected renew fixture warmup to build the current cache");
    const scheduledResponse = await request(`http://127.0.0.1:${PORT}/api/renew-on-start`, { method: "POST" });
    assert.equal(scheduledResponse.status, 200, "Expected /api/renew-on-start to return 200");
    const scheduledPayload = JSON.parse(scheduledResponse.body);
    assert.equal(scheduledPayload.ok, true, "Expected renew-on-start scheduling response to confirm success");
  } finally {
    await new Promise((resolve) => firstServer.close(resolve));
  }

  appendRenewFixtureData();

  const renewedStartServer = loadStartServer({ dbPath: renewDbPath });
  const renewedServer = renewedStartServer(PORT);
  try {
    await waitForServer(renewedServer);
    const renewedPayload = await fetchIndexPayload(PORT);
    assert.equal(
      renewedPayload.stats.totalItems,
      16,
      "Expected renew-on-start to ignore the old SQLite cache and rebuild immediately",
    );
    assert(
      renewedPayload.items.some((item) => item.genId === "gen_after_renew"),
      "Expected renew-on-start to include items added after the previous cached build",
    );
  } finally {
    await new Promise((resolve) => renewedServer.close(resolve));
  }
  const renewMarkerPath = path.join(APP_DATA_DIR, "sqlite-renew-next-start.json");
  const renewMarker = JSON.parse(fs.readFileSync(renewMarkerPath, "utf8"));
  assert(renewMarker.consumedAt, "Expected the renew-on-start marker to be consumed after the next startup");
}

async function run() {
  writeFixtureData();
  await assertPortRetryWorks();
  await assertRestartUsesCachedIndexUntilRebuild();
  await assertRenewOnStartForcesFreshRebuild();
  resetFixtureManifest();
  const startServer = loadStartServer({ dbPath: path.join(TMP_ROOT, "main.sqlite") });
  const server = startServer(PORT);

  try {
    await waitForServer(server);

    const indexPayload = await requestJson(`http://127.0.0.1:${PORT}/api/index`, "Expected /api/index to return 200");
    assert.equal(indexPayload.items.length, 14, "Expected all base manifest and local-only fixture items to remain indexed");
    assert.equal(indexPayload.stats.totalItems, 14, "Expected stats to report all indexed items");
    assert.equal(indexPayload.stats.withLocalMedia, 10, "Expected merged items plus char, cameos, remix, and nested creator sources to match local media pairs");
    assert.equal(indexPayload.stats.database.configured, true, "Expected SQLite cache configuration metadata");
    assert(indexPayload.stats.sourceOrder.includes("v2_cameos"), "Expected cameos sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_cameo_drafts"), "Expected cameos draft sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_char_@sparklecat"), "Expected char sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_char_drafts_@sparklecat"), "Expected char draft sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_remix_children"), "Expected nested remix children sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_remix_parents"), "Expected nested remix parent sources to be included in source order");
    assert(indexPayload.stats.sourceOrder.includes("v2_@nested_creator"), "Expected nested creator user directories to surface as custom user sources");
    assert(indexPayload.stats.sourceOrder.includes("v2_char_@nestedcat"), "Expected nested creator char post directories to surface as char sources");
    assert.equal(indexPayload.stats.sourceOrder.includes("v2_remixes"), false, "Expected the remix container directory not to leak as its own source");
    assert.equal(indexPayload.stats.sourceOrder.includes("v2_creators"), false, "Expected the nested creator container directory not to leak as its own source");
    const likedDiagnostics = indexPayload.stats.sourceDiagnostics.find((entry) => entry.source === "v2_liked");
    assert(likedDiagnostics, "Expected source diagnostics to include the liked source");
    assert.equal(likedDiagnostics.files, 2, "Expected liked diagnostics to count raw local files");
    assert.equal(likedDiagnostics.mp4Files, 1, "Expected liked diagnostics to count local mp4 files");
    assert.equal(likedDiagnostics.txtFiles, 1, "Expected liked diagnostics to count local txt files");
    assert.equal(likedDiagnostics.directoryPath, LIKED_DIR, "Expected liked diagnostics to expose the scanned source directory");
    assert.equal(likedDiagnostics.uniqueGenerationIds, 1, "Expected liked diagnostics to summarize unique generation IDs");
    assert.equal(likedDiagnostics.uniquePostIds, 1, "Expected liked diagnostics to summarize unique post IDs");
    assert.equal(likedDiagnostics.matchedGroups, 1, "Expected liked diagnostics to count matched local groups");
    assert.equal(likedDiagnostics.unmatchedGroups, 0, "Expected liked diagnostics to report no unmatched liked groups");
    assert.equal(likedDiagnostics.indexedItems, 2, "Expected liked diagnostics to report manifest-backed items in the liked source");
    assert.equal(likedDiagnostics.itemsWithSourceLocalMedia, 1, "Expected liked diagnostics to report source-local media attachments");
    assert.deepEqual(
      indexPayload.stats.manifests[0].scanSources,
      ["v2_profile", "v2_liked", "v2_user", "v2_remix_children", "v2_remix_parents"],
      "Expected /api/stats to expose manifest scan_sources metadata",
    );
    const buildStatusPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/build-status`,
      "Expected /api/build-status to return 200",
    );
    assert.equal(typeof buildStatusPayload.hasCachedIndex, "boolean", "Expected build status to report whether a cached index exists");
    assert.equal(typeof buildStatusPayload.isBuilding, "boolean", "Expected build status to report active rebuild state");
    assert.equal(typeof buildStatusPayload.progress, "object", "Expected build status to include a progress payload");
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
    assert.deepEqual(sharedUserItem.sourceMemberships, ["v2_liked", "v2_user", "v2_@bucket_user"]);
    assert.equal(sharedUserItem.hasLocalMedia, true, "Expected the custom user directory to attach local media");
    const nestedCreatorItem = indexPayload.items.find((item) => item.genId === "gen_nestedcreator111");
    assert(nestedCreatorItem, "Expected the nested creator manifest fixture item to be present");
    assert.equal(nestedCreatorItem.hasLocalMedia, true, "Expected nested creator media to attach to its manifest item");
    assert(nestedCreatorItem.sourceMemberships.includes("v2_@nested_creator"), "Expected nested creator items to retain a custom user alias source membership");
    const remixChildItem = indexPayload.items.find((item) => item.genId === "gen_remixchild111");
    assert(remixChildItem, "Expected the nested remix child fixture item to be present");
    assert.equal(remixChildItem.hasLocalMedia, true, "Expected nested remix child media to attach to its manifest item");
    assert.deepEqual(remixChildItem.sourceMemberships, ["v2_remix_children"]);
    const remixParentItem = indexPayload.items.find((item) => item.genId === "gen_remixparent111");
    assert(remixParentItem, "Expected the nested remix parent fixture item to be present");
    assert.equal(remixParentItem.hasLocalMedia, true, "Expected nested remix parent media to attach to its manifest item");
    assert.deepEqual(remixParentItem.sourceMemberships, ["v2_remix_parents"]);
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

    const nestedCustomUserFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_@nested_creator")}`,
      "Expected nested creator custom user filter search to return 200",
    );
    assert.equal(nestedCustomUserFilterPayload.items.length, 1, "Expected only the nested creator manifest item to appear in the custom user filter");
    assert.equal(nestedCustomUserFilterPayload.items[0].genId, "gen_nestedcreator111");

    const nestedCharFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_char_@nestedcat")}`,
      "Expected nested creator char filter search to return 200",
    );
    assert.equal(nestedCharFilterPayload.items.length, 1, "Expected only the nested creator char local-only item to appear in the char filter");
    assert.equal(nestedCharFilterPayload.items[0].genId, "gen_nestedchar111");

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

    const remixChildrenFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_remix_children`,
      "Expected nested remix children filter search to return 200",
    );
    assert.equal(remixChildrenFilterPayload.items.length, 1, "Expected only the remix child manifest item to appear in the remix children filter");
    assert.equal(remixChildrenFilterPayload.items[0].genId, "gen_remixchild111");
    assert.equal(remixChildrenFilterPayload.items[0].hasLocalMedia, true, "Expected remix child filter results to keep local media attached");

    const remixParentsFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_remix_parents`,
      "Expected nested remix parents filter search to return 200",
    );
    assert.equal(remixParentsFilterPayload.items.length, 1, "Expected only the remix parent manifest item to appear in the remix parents filter");
    assert.equal(remixParentsFilterPayload.items[0].genId, "gen_remixparent111");
    assert.equal(remixParentsFilterPayload.items[0].hasLocalMedia, true, "Expected remix parent filter results to keep local media attached");

    const manifestGapPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?manifestGapOnly=1`,
      "Expected manifest-gap filter search to return 200",
    );
    assert.equal(manifestGapPayload.items.length, 5, "Expected only local-only fixture items to appear in the manifest-gap filter");
    assert(manifestGapPayload.items.every((item) => item.kind === "local-only"), "Expected manifest-gap filter items to all be local-only");
    assert(manifestGapPayload.items.every((item) => item.hasLocalMedia), "Expected manifest-gap fixture items to remain directly playable");

    const remoteOnlyPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?remoteOnly=1`,
      "Expected remote-only filter search to return 200",
    );
    assert.equal(remoteOnlyPayload.items.length, 4, "Expected only manifest entries without local files to appear in the remote-only filter");
    assert(remoteOnlyPayload.items.every((item) => item.kind === "manifest"), "Expected remote-only items to stay on manifest-backed entries");
    assert(remoteOnlyPayload.items.every((item) => !item.hasLocalMedia && !item.hasLocalText), "Expected remote-only items not to expose local media or text");

    const mergedFilterPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=v2_profile,v2_liked`,
      "Expected merged source filter search to return 200",
    );
    assert.equal(mergedFilterPayload.items.filter((item) => item.genId === "gen_smoke123").length, 1, "Expected shared items to stay deduped across multiple selected filters");

    const idCoreAscendingPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_profile,v2_liked,v2_@bucket_user")}&sort=idcore-asc`,
      "Expected ID core ascending sort to return 200",
    );
    assert.deepEqual(
      idCoreAscendingPayload.items.slice(0, 3).map((item) => item.genId),
      ["gen_other999", "gen_smoke123", "gen_user999"],
      "Expected ID core ascending sort to use the shared core portion before placing ID-less items last",
    );

    const idCoreDescendingPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_profile,v2_liked,v2_@bucket_user")}&sort=idcore-desc`,
      "Expected ID core descending sort to return 200",
    );
    assert.deepEqual(
      idCoreDescendingPayload.items.slice(0, 3).map((item) => item.genId),
      ["gen_user999", "gen_smoke123", "gen_other999"],
      "Expected ID core descending sort to reverse the shared core ordering while keeping ID-less items last",
    );

    const posterPostsDescendingPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/index?sources=${encodeURIComponent("v2_profile,v2_liked,v2_@bucket_user")}&sort=poster-posts-desc`,
      "Expected poster post-count sort to return 200",
    );
    assert.deepEqual(
      posterPostsDescendingPayload.items
        .filter((item) => item.posterUsername)
        .slice(0, 6)
        .map((item) => item.posterUsername),
      ["bucket_user", "fallback_alpha", "fallback_beta", "literal_marker", "other_user", "smoke_user"],
      "Expected poster post-count sort ties to fall back to poster username order",
    );

    const recentPostersPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/posters?sources=${encodeURIComponent("v2_profile,v2_liked,v2_@bucket_user")}&posterSort=recent-post-desc`,
      "Expected poster recency sort to return 200",
    );
    assert.deepEqual(
      recentPostersPayload.items,
      ["smoke_user", "other_user", "fallback_alpha", "literal_marker", "fallback_beta", "bucket_user"],
      "Expected poster usernames to sort by most recent post first",
    );

    const oldestPostersPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/posters?sources=${encodeURIComponent("v2_profile,v2_liked,v2_@bucket_user")}&posterSort=recent-post-asc`,
      "Expected oldest poster recency sort to return 200",
    );
    assert.deepEqual(
      oldestPostersPayload.items,
      ["bucket_user", "fallback_beta", "literal_marker", "fallback_alpha", "other_user", "smoke_user"],
      "Expected poster usernames to sort by oldest post first",
    );

    const mostLikedPostersPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/posters?sources=${encodeURIComponent("v2_profile,v2_liked,v2_@bucket_user")}&posterSort=likes-desc`,
      "Expected poster like sort to return 200",
    );
    assert.deepEqual(
      mostLikedPostersPayload.items,
      ["smoke_user", "bucket_user", "other_user", "fallback_alpha", "fallback_beta", "literal_marker"],
      "Expected poster usernames to sort by total likes descending",
    );

    const fewestLikedPostersPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/posters?sources=${encodeURIComponent("v2_profile,v2_liked,v2_@bucket_user")}&posterSort=likes-asc`,
      "Expected ascending poster like sort to return 200",
    );
    assert.deepEqual(
      fewestLikedPostersPayload.items,
      ["fallback_alpha", "fallback_beta", "literal_marker", "other_user", "bucket_user", "smoke_user"],
      "Expected poster usernames to sort by total likes ascending",
    );

    const copiedPostIdsPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/identifiers?query=${encodeURIComponent("Smoke test prompt")}&field=postId`,
      "Expected post_id clipboard endpoint to return 200",
    );
    assert.deepEqual(copiedPostIdsPayload.items, [mainItem.postId], "Expected post_id clipboard endpoint to return the filtered manifest post ID");

    const copiedGenIdsPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/identifiers?query=${encodeURIComponent("Smoke test prompt")}&field=genId`,
      "Expected gen_id clipboard endpoint to return 200",
    );
    assert.deepEqual(copiedGenIdsPayload.items, [mainItem.genId], "Expected gen_id clipboard endpoint to return the filtered generation ID");

    const copiedTaskIdsPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/identifiers?query=${encodeURIComponent("Smoke test prompt")}&field=taskId`,
      "Expected task_id clipboard endpoint to return 200",
    );
    assert.deepEqual(copiedTaskIdsPayload.items, [mainItem.taskId], "Expected task_id clipboard endpoint to return the filtered task ID");

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
    assert.equal(detailPayload.local.txtUrl, "/media?id=gen_smoke123&kind=txt");
    assert.equal(detailPayload.manifestSupplement.item._raw.profile.user_id, "user-smoke", "Expected detail payload to expose nested manifest supplement profile data");
    assert.equal(detailPayload.manifestSupplement.item._raw.post.like_count, 7, "Expected detail payload to expose nested manifest supplement post data");
      assert.equal(detailPayload.cameoProfiles.length, 1, "Expected cameo profile metadata to be preserved");
      assert.equal(detailPayload.cameoProfiles[0].username, "cameo.source.hero");
      assert.equal(detailPayload.posterDescription, "Primary smoke profile description.");
      assert.equal(detailPayload.cameoProfiles[0].description, "Friendly cameo hero description.");
      assert.equal(fs.existsSync(path.join(APP_DATA_DIR, "txt-record-cache.json")), true, "Expected TXT cache file to be created");

    const ambiguousDetailPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/item/${encodeURIComponent(ambiguousItem.id)}`,
      "Expected the ambiguous task fixture detail to load",
    );
    assert.equal(ambiguousDetailPayload.mediaUrl, null, "Expected the ambiguous task fixture not to inherit the local media URL");

    const localOnlyItem = manifestGapPayload.items.find((item) => item.genId === "gen_char111");
    assert(localOnlyItem, "Expected a local-only char fixture item to be available for detail testing");
    const localOnlyDetailPayload = await requestJson(
      `http://127.0.0.1:${PORT}/api/item/${encodeURIComponent(localOnlyItem.id)}`,
      "Expected local-only fixture detail to load",
    );
    assert.equal(localOnlyDetailPayload.kind, "local-only", "Expected local-only detail payload kind to be preserved");
    assert.equal(localOnlyDetailPayload.mediaUrl, `/media?id=${encodeURIComponent(localOnlyItem.id)}&kind=media`, "Expected local-only fixture detail to expose its playable media URL");

    const mediaResponse = await request(`http://127.0.0.1:${PORT}${detailPayload.mediaUrl}`);
    assert.equal(mediaResponse.status, 200, "Expected /media to return 200");

    const txtResponse = await request(`http://127.0.0.1:${PORT}${detailPayload.local.txtUrl}`);
    assert.equal(txtResponse.status, 200, "Expected TXT /media to return 200");
    assert.equal(txtResponse.body.includes("Smoke test prompt"), true, "Expected TXT /media to expose the transcript on demand");

    const cameoAvatarResponse = await request(
      `http://127.0.0.1:${PORT}/avatar?id=${encodeURIComponent(mainItem.id)}&role=cameo&username=${encodeURIComponent("cameo.source.hero")}`,
    );
    assert.equal(cameoAvatarResponse.status, 200, "Expected /avatar to resolve cameo avatars from owner_<cameo username> fallback files");

    const byIdManifestPath = path.join(DATA_DIR, MANIFEST_FILE_NAME);
    const byIdManifest = JSON.parse(fs.readFileSync(byIdManifestPath, "utf8"));
    byIdManifest.total += 1;
    byIdManifest.items.push({
      source: "v2_by_id",
      genId: "s_byid0001-attachment-0",
      taskId: "task_byid0001",
      postId: "s_byid0001",
      date: "2026-04-16",
      prompt: "By-id manifest should attach local media",
      _raw: {
        profile: { username: "byid_user" },
        post: {
          id: "s_byid0001",
          text: "By-id manifest should attach local media",
          attachments: [{ generation_id: "s_byid0001-attachment-0" }],
          cameo_profiles: [],
        },
      },
    });
    fs.writeFileSync(byIdManifestPath, JSON.stringify(byIdManifest, null, 2), "utf8");
    fs.writeFileSync(
      path.join(CHAR_DIR, "2026-04-16_s_byid0001-attachment-0.mp4"),
      Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
    );
    fs.writeFileSync(
      path.join(CHAR_DIR, "2026-04-16_s_byid0001-attachment-0.txt"),
      [
        "Source: v2_char_@sparklecat",
        "Generation ID: s_byid0001-attachment-0",
        "Task ID: task_byid0001",
        "Post ID: s_byid0001",
        "Date: 2026-04-16",
        "Duration: 5",
        "Resolution: 720x1280",
        "Aspect ratio: 9:16",
        "Liked: no",
        "Prompt",
        "By-id manifest should attach local media",
      ].join("\n"),
      "utf8",
    );

    const byIdRebuildResponse = await request(`http://127.0.0.1:${PORT}/api/rebuild`, { method: "POST" });
    assert.equal(byIdRebuildResponse.status, 200, "Expected /api/rebuild to succeed for by-id attachment regression coverage");

    const byIdPayload = await waitForCondition(async () => {
      const payload = await fetchIndexPayload(PORT, `?query=${encodeURIComponent("By-id manifest should attach local media")}`);
      return payload.items.length ? payload : null;
    });
    const byIdItem = byIdPayload.items.find((item) => item.genId === "s_byid0001-attachment-0");
    assert(byIdItem, "Expected the by-id manifest fixture item to be present after rebuild");
    assert.equal(byIdItem.hasLocalMedia, true, "Expected exact generation/post IDs to attach local media even when manifest source is v2_by_id");
    assert.equal(byIdItem.kind, "manifest", "Expected the by-id fixture to stay attached to its manifest item instead of becoming local-only");
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
