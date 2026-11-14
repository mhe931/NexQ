// Fails when tracked (or staged) files look like they contain credentials or
// private content. Run before every push:  node scripts/secret-scan.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export const SECRET_PATTERNS = [
  ["OpenAI-style key", /\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{24,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{30,}={0,2}/],
  ["API key in URL", /[?&](?:key|api_key|apikey|access_token)=[A-Za-z0-9_-]{20,}/],
];

/** Document, recording and database types that hold personal content. */
export const PRIVATE_EXTENSIONS = /\.(?:pptx|docx|pdf|db|sqlite|wav|mp3|m4a|opus|ogg)$|\.local\.(?:json|md)$/i;

/** Public example files that are allowed to be binary documents. */
const ALLOWED_PATHS = [/^website\//, /^public\//, /^src-tauri\/icons\//, /^docs\/.*\.(?:png|pdf)$/];
const PLACEHOLDER = /nexq-unit-test-key-not-a-credential|sk-abcdefghijklmnopqrstuvwxyz|AIzaSyA1234567890abcdefghijklmnopqrstuvwxyz?/;
/** Files whose purpose is to contain credential-shaped test strings (fake values only). */
const CONTENT_EXEMPT = [
  /^scripts\/secret-scan\.(?:mjs|test\.ts)$/,
  /^src-tauri\/src\/profiles\/model\.rs$/,
  /^src-tauri\/src\/logging\.rs$/, // redaction tests use made-up key shapes
];

export function scanText(path, text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (PLACEHOLDER.test(line)) return;
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(line)) findings.push({ path, line: i + 1, rule: name });
    }
  });
  return findings;
}

export function scanPath(path) {
  if (PRIVATE_EXTENSIONS.test(path) && !ALLOWED_PATHS.some((re) => re.test(path))) {
    return [{ path, line: 0, rule: "Private document/data file type must not be committed" }];
  }
  return [];
}

function listFiles() {
  const staged = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], { encoding: "utf8" });
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return [...new Set((staged + "\n" + tracked).split(/\r?\n/).filter(Boolean))];
}

function main() {
  const findings = [];
  for (const path of listFiles()) {
    findings.push(...scanPath(path));
    if (!existsSync(path) || CONTENT_EXEMPT.some((re) => re.test(path)) || /\.(?:png|ico|icns|jpg|jpeg|gif|webp|woff2?|dll|exe|zip)$/i.test(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    findings.push(...scanText(path, text));
  }
  if (findings.length) {
    for (const f of findings) console.error(`${f.path}${f.line ? `:${f.line}` : ""}  ${f.rule}`);
    console.error(`\nSecret scan failed: ${findings.length} finding(s). Values are intentionally not printed.`);
    process.exit(1);
  }
  console.log("Secret scan passed: no credentials or private document types in tracked files.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) main();
