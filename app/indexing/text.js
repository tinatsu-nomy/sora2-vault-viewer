const fs = require("fs");

const {
  basenameWithoutExt,
  extractIdTokens,
} = require("./common");

const fsp = fs.promises;

const TEXT_DECODERS = [
  { name: "utf-8", decoder: new TextDecoder("utf-8", { fatal: false }) },
  { name: "shift_jis", decoder: new TextDecoder("shift_jis", { fatal: false }) },
];

function likelyBrokenText(value) {
  if (!value) return false;
  return /�|ƒ|„|ں|پ~/.test(value);
}

function scoreDecodedText(value) {
  if (!value) return Number.NEGATIVE_INFINITY;
  let score = 0;
  if (!likelyBrokenText(value)) score += 1000;
  if (/Prompt/i.test(value)) score += 100;
  if (/[一-龯ぁ-んァ-ヶ]/.test(value)) score += 50;
  score += Math.min(value.length, 500);
  return score;
}

async function decodeTextFile(filePath) {
  const raw = await fsp.readFile(filePath);
  let best = { text: "", encoding: "utf-8", score: Number.NEGATIVE_INFINITY };
  for (const candidate of TEXT_DECODERS) {
    const text = candidate.decoder.decode(raw);
    const score = scoreDecodedText(text);
    if (score > best.score) {
      best = { text, encoding: candidate.name, score };
    }
  }
  return { text: best.text.replace(/\r\n/g, "\n"), encoding: best.encoding };
}

async function parseTxtRecord(filePath, sourceDirName) {
  const { text, encoding } = await decodeTextFile(filePath);
  const lines = text.split("\n");
  const metadata = {};
  let promptStart = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/Prompt/.test(line)) {
      promptStart = index + 1;
      continue;
    }
    const match = line.match(/^([^:]+?)\s*:\s*(.+)$/);
    if (match) {
      metadata[match[1].trim()] = match[2].trim();
    }
  }

  const prompt = promptStart >= 0 ? lines.slice(promptStart).join("\n").trim() : "";
  const stem = basenameWithoutExt(filePath);
  const idTokens = new Set(extractIdTokens(stem));
  for (const value of Object.values(metadata)) {
    for (const token of extractIdTokens(value)) {
      idTokens.add(token);
    }
  }

  return {
    type: "localFile",
    source: metadata.Source || sourceDirName,
    generationId: metadata["Generation ID"] || null,
    taskId: metadata["Task ID"] || null,
    postId: metadata["Post ID"] || null,
    date: metadata.Date || null,
    duration: metadata.Duration || null,
    resolution: metadata.Resolution || null,
    aspectRatio: metadata["Aspect ratio"] || null,
    liked: metadata.Liked || null,
    prompt,
    rawText: text,
    encoding,
    stem,
    idTokens: [...idTokens],
    filePath,
  };
}

module.exports = {
  decodeTextFile,
  parseTxtRecord,
};
