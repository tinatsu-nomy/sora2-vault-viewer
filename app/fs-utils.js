const fs = require("fs");
const path = require("path");

const fsp = fs.promises;

function normalizePathKey(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function classifyDirEntry(parentDir, entry) {
  const entryPath = path.join(parentDir, entry.name);

  if (entry.isDirectory()) {
    return { path: entryPath, type: "directory" };
  }

  if (entry.isFile()) {
    return { path: entryPath, type: "file" };
  }

  if (!entry.isSymbolicLink()) {
    return { path: entryPath, type: "other" };
  }

  try {
    const stat = await fsp.stat(entryPath);
    if (stat.isDirectory()) {
      return { path: entryPath, type: "directory" };
    }
    if (stat.isFile()) {
      return { path: entryPath, type: "file" };
    }
    return { path: entryPath, type: "other" };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { path: entryPath, type: "missing" };
    }
    throw error;
  }
}

async function realPathKey(targetPath) {
  try {
    return normalizePathKey(await fsp.realpath(targetPath));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

module.exports = {
  classifyDirEntry,
  realPathKey,
};
