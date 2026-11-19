import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ID = /^(ctx|hms):([A-Za-z0-9_-]{12})$/;
export const isShortReference = id => ID.test(id);

function referenceDir() {
  const stateHome = process.env.XDG_STATE_HOME;
  const base = path.isAbsolute(stateHome ?? '') ? stateHome : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'hms', 'refs');
}

const digest = text => crypto.createHash('sha256').update(text).digest('base64url').slice(0, 12);
const fileName = (kind, key) => `${kind}-${key}.json`;

export function saveReference(kind, value) {
  const text = JSON.stringify(value);
  const key = digest(text);
  const id = `${kind}:${key}`;
  const dir = referenceDir();
  const file = path.join(dir, fileName(kind, key));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    const draft = path.join(dir, `.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(draft, text, { flag: 'wx', mode: 0o600 });
      try { fs.linkSync(draft, file); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally {
      fs.rmSync(draft, { force: true });
    }
  }
  // The same reference may be published by multiple agents at once.
  if (fs.readFileSync(file, 'utf8') !== text) throw new Error(`HMS 短 ID ${id} 与本地记录冲突`);
  return id;
}

export function loadReference(id) {
  const parts = ID.exec(id);
  if (!parts) throw new Error(`HMS 短 ID 格式无效：${id}`);
  const [, kind, key] = parts;
  const file = path.join(referenceDir(), fileName(kind, key));
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error(`找不到 HMS 短 ID ${id}，请核对本地状态目录 ${path.dirname(file)}`);
    throw e;
  }
  if (digest(text) !== key) throw new Error(`HMS 短 ID ${id} 的本地记录已损坏`);
  return JSON.parse(text);
}
