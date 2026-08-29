// Собирает два самодостаточных HTML-файла: game.html и editor.html.
// Весь JS (включая three.js) инлайнится внутрь — файлы открываются двойным кликом,
// без сервера и без интернета.
import * as esbuild from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes('--dev');

const TARGETS = [
  { entry: 'src/game/main.js', html: 'src/game/index.html', out: 'game.html' },
  { entry: 'src/editor/main.js', html: 'src/editor/index.html', out: 'editor.html' }
];

async function buildOne(t) {
  const result = await esbuild.build({
    entryPoints: [resolve(root, t.entry)],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'],
    minify: !dev,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    logLevel: 'warning'
  });

  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = await readFile(resolve(root, t.html), 'utf8');
  if (!html.includes('/*BUNDLE*/')) throw new Error('нет маркера /*BUNDLE*/ в ' + t.html);
  const out = html.replace('/*BUNDLE*/', () => js);
  await writeFile(resolve(root, t.out), out, 'utf8');
  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(0);
  console.log(`  ${t.out.padEnd(14)} ${kb} КБ`);
}

// Панель сервера бандлить нечем — в ней обычный скрипт без импортов,
// поэтому просто кладём её рядом с игрой.
async function copyStatic() {
  const src = await readFile(resolve(root, 'src/server/index.html'), 'utf8');
  await writeFile(resolve(root, 'server.html'), src, 'utf8');
  const kb = (Buffer.byteLength(src, 'utf8') / 1024).toFixed(0);
  console.log(`  ${'server.html'.padEnd(14)} ${kb} КБ`);
}

const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7) : null;

console.log(dev ? 'Сборка (dev, без минификации):' : 'Сборка:');
for (const t of TARGETS) {
  if (only && !t.out.includes(only)) continue;
  try { await buildOne(t); }
  catch (e) { console.error(`  ${t.out}: ОШИБКА — ${e.message}`); process.exitCode = 1; }
}
try { await copyStatic(); }
catch (e) { console.error(`  server.html: ОШИБКА — ${e.message}`); process.exitCode = 1; }
