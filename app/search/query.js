const { parseDateValue, slugForText } = require("../indexer");

function isUsernameOnlyQuery(text) {
  return /^@[!-~]+$/.test(text);
}

function parseSearchQuery(value) {
  if (value == null) {
    return {
      textQuery: "",
      usernamePrefixes: [],
      forceSimpleTextSearch: false,
    };
  }

  const text = String(value).trim();
  if (!text) {
    return {
      textQuery: "",
      usernamePrefixes: [],
      forceSimpleTextSearch: false,
    };
  }

  if (!/\s/.test(text) && isUsernameOnlyQuery(text)) {
    return {
      textQuery: "",
      usernamePrefixes: [slugForText(text.slice(1))],
      forceSimpleTextSearch: false,
    };
  }

  return {
    textQuery: slugForText(text),
    usernamePrefixes: [],
    forceSimpleTextSearch: /\s|@/.test(text),
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
    forceSimpleTextSearch: searchQuery.forceSimpleTextSearch,
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
