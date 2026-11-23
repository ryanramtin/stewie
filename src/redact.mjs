// One place that knows what a secret looks like. Everything stewie writes down
// (imports, memory, notes) goes through it first: the log is durable, and a
// durable copy of a key is the one mistake you cannot take back.

const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Token-shaped text is scrubbed wherever it appears. */
export function scrubSecrets(text) {
  let out = String(text);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, '«redacted»');
  return out;
}
