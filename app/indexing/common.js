function slugForText(value) {
  if (!value) return "";
  return String(value).toLowerCase();
}

function parseDateValue(value, { endOfDayIfDateOnly = false } = {}) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const text = String(value).trim();
  if (!text) return null;

  const dateOnlyMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    const parsed = endOfDayIfDateOnly
      ? new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
      : new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
    const timestamp = parsed.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const localDateTimeMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (localDateTimeMatch) {
    const [, year, month, day, hour, minute, second = "0", fraction = "0"] = localDateTimeMatch;
    const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      milliseconds,
    );
    const timestamp = parsed.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function basenameWithoutExt(filePath) {
  const path = require("path");
  return path.basename(filePath, path.extname(filePath));
}

function extractIdTokens(value) {
  if (!value) return [];
  const text = String(value);
  const matches = new Set();
  const patterns = [
    /gen_[a-z0-9]+/gi,
    /task_[a-z0-9]+/gi,
    /s_[a-z0-9]+(?:-attachment-\d+)?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.add(match[0]);
    }
  }
  return [...matches];
}

function sortableDuration(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function addLookup(map, key, entryId) {
  if (!key) return;
  const normalized = slugForText(key);
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, new Set());
  map.get(normalized).add(entryId);
}

function isCustomUserSource(source) {
  return /^v2_@/i.test(String(source || ""));
}

function compareSourceKeys(left, right) {
  if (left === right) return 0;
  if (left === "v2_profile") return -1;
  if (right === "v2_profile") return 1;
  const leftIsCustomUser = isCustomUserSource(left);
  const rightIsCustomUser = isCustomUserSource(right);
  if (leftIsCustomUser !== rightIsCustomUser) return leftIsCustomUser ? 1 : -1;
  return String(left || "").localeCompare(String(right || ""));
}

function normalizeSourceMemberships(sources) {
  return [...new Set((sources || []).filter(Boolean))].sort(compareSourceKeys);
}

function pickPrimarySource(sources) {
  return normalizeSourceMemberships(sources)[0] || null;
}

module.exports = {
  addLookup,
  basenameWithoutExt,
  compareSourceKeys,
  extractIdTokens,
  isCustomUserSource,
  normalizeSourceMemberships,
  parseDateValue,
  parseJson,
  pickPrimarySource,
  slugForText,
  sortableDuration,
};
