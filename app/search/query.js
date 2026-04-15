const { parseDateValue, slugForText } = require("../indexer");

function parseSearchQuery(value) {
  if (value == null) {
    return {
      textQuery: "",
      usernamePrefixes: [],
    };
  }

  const terms = String(value)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const textTerms = [];
  const usernamePrefixes = [];

  for (const term of terms) {
    if (!term.startsWith("@")) {
      textTerms.push(term);
      continue;
    }

    const normalizedUsername = term.replace(/^@+/, "").trim();
    if (normalizedUsername) {
      usernamePrefixes.push(slugForText(normalizedUsername));
    }
  }

  return {
    textQuery: slugForText(textTerms.join(" ")),
    usernamePrefixes,
  };
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

function buildFtsMatchQuery(query) {
  const terms = String(query || "")
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (!terms.length) return null;
  if (terms.some((term) => /["':*()\-]/.test(term))) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}

function parseListParams(url) {
  const searchQuery = parseSearchQuery(url.searchParams.get("query"));
  const query = searchQuery.textQuery;
  const source = url.searchParams.get("source");
  const hasSourcesParam = url.searchParams.has("sources");
  const sources = url.searchParams
    .get("sources")
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) || [];
  const localOnly = url.searchParams.get("localOnly") === "1";
  const withText = url.searchParams.get("withText") === "1";
  const withMedia = url.searchParams.get("withMedia") === "1";
  const dateFrom = parseDateValue(url.searchParams.get("dateFrom"));
  const dateTo = parseDateValue(url.searchParams.get("dateTo"), { endOfDayIfDateOnly: true });
  const sort = url.searchParams.get("sort") || "date-desc";
  const requestedLimit = Number(url.searchParams.get("limit") || 180);
  const requestedOffset = Number(url.searchParams.get("offset") || 0);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 180, 240));
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);

  return {
    query,
    usernamePrefixes: searchQuery.usernamePrefixes,
    source,
    hasSourcesParam,
    sources,
    localOnly,
    withText,
    withMedia,
    dateFrom,
    dateTo,
    sort,
    limit,
    offset,
  };
}

module.exports = {
  buildFtsMatchQuery,
  escapeLikePattern,
  parseListParams,
  parseSearchQuery,
};
