#!/usr/bin/env node
// Only the six reviewed browser assets are copied into the Worker asset binding
import { lstat, readdir, readFile, realpath, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 이상이 필요합니다');
const options = process.argv.slice(2);
if (options.length > 1 || (options.length && !['--check', '--clean', '--dry-run'].includes(options[0]))) {
  throw new Error('사용법: node scripts/prepare-assets.mjs [--check | --clean | --dry-run]');
}
const mode = options[0] || '--build';
const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const output = path.resolve(root, 'public_assets');
const allowlist = Object.freeze([
  'admin/index.html', 'admin/admin.js', 'admin/admin.css',
  'workspace/index.html', 'workspace/workspace.js', 'workspace/workspace.css',
]);
const allowedFiles = new Set(allowlist);
const allowedDirectories = new Set(['admin', 'workspace']);
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function assertOutputTarget(target) {
  if (!samePath(path.resolve(target), output) || !within(root, path.resolve(target)) || path.basename(target) !== 'public_assets') {
    throw new Error('허용된 public_assets 디렉터리 밖의 경로는 변경할 수 없습니다');
  }
}
async function maybeStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function regularDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
    throw new Error('심볼릭 링크 또는 예상과 다른 디렉터리는 사용할 수 없습니다: ' + path.relative(root, directory));
  }
}
async function inspectOutput() {
  assertOutputTarget(output);
  const info = await maybeStat(output);
  if (!info) return false;
  await regularDirectory(output);
  // Refuse deletion if a user placed an unrelated file, link, junction or directory here
  for (const top of await readdir(output)) {
    const directory = path.join(output, top);
    if (!allowedDirectories.has(top)) throw new Error('예상하지 않은 출력 항목을 보존했습니다: ' + top);
    await regularDirectory(directory);
    for (const name of await readdir(directory)) {
      const relative = top + '/' + name, file = path.join(directory, name), entry = await lstat(file);
      if (!allowedFiles.has(relative) || !entry.isFile() || entry.isSymbolicLink() || !samePath(await realpath(file), file)) {
        throw new Error('예상하지 않은 출력 파일 또는 링크를 보존했습니다: ' + relative);
      }
    }
  }
  return true;
}
async function clean() {
  if (!await inspectOutput()) return;
  // Resolve and verify the final absolute target immediately before the only recursive removal
  assertOutputTarget(await realpath(output));
  await rm(output, { recursive: true, force: false });
}
if (mode === '--clean') {
  await clean();
  process.stdout.write('검증된 public_assets 출력만 정리했습니다\n');
} else {
  const files = [];
  for (const directory of allowedDirectories) await regularDirectory(path.join(root, directory));
  for (const name of allowlist) {
    const source = path.resolve(root, ...name.split('/'));
    if (!within(root, source)) throw new Error('소스 경로가 저장소 밖을 가리킵니다');
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || !samePath(await realpath(source), source) || info.size > 5 * 1024 * 1024) {
      throw new Error('일반 공개 소스 파일만 5MB 이내로 복사할 수 있습니다: ' + name);
    }
    const bytes = await readFile(source);
    files.push({ name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  // All source files are read successfully before a previous output is removed
  const exists = await inspectOutput();
  if (mode === '--check') {
    if (!exists) throw new Error('public_assets가 없습니다 먼저 준비 스크립트를 실행해 주세요');
    for (const file of files) {
      const built = await readFile(path.join(output, ...file.name.split('/')));
      if (!built.equals(file.bytes)) throw new Error('소스와 출력이 다릅니다 다시 준비해 주세요: ' + file.name);
    }
  } else if (mode === '--build') {
    await clean();
    await mkdir(output, { recursive: false });
    for (const directory of allowedDirectories) await mkdir(path.join(output, directory), { recursive: false });
    for (const file of files) {
      const destination = path.resolve(output, ...file.name.split('/'));
      if (!within(output, destination)) throw new Error('출력 파일이 public_assets 밖을 가리킵니다');
      await writeFile(destination, file.bytes, { flag: 'wx' });
    }
  }
  process.stdout.write(JSON.stringify({ mode, output, files: files.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 })) }, null, 2) + '\n');
}
