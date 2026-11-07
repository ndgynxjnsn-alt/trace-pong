// Build the Grafana plugin: bundle src/module.tsx with esbuild into an AMD module (the format
// Grafana loads plugins in), copy the static files, and optionally zip it for distribution.
//   node build.mjs          -> build/tracepong-live-panel/
//   node build.mjs --dev    -> same, unminified with inline source maps
//   node build.mjs --zip    -> also dist/tracepong-live-panel-<version>.zip
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ID = 'tracepong-live-panel';
const dev = process.argv.includes('--dev');
const zip = process.argv.includes('--zip');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const out = path.join('build', ID);

// Provided by Grafana at runtime; everything else is bundled.
const EXTERNALS = ['react', '@grafana/data', '@grafana/runtime', 'rxjs'];

fs.rmSync('build', { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// esbuild has no AMD output: emit CommonJS and wrap it in define(), mapping require() of the
// externals onto the modules Grafana hands to define.
const args = EXTERNALS.map((_, i) => `__ext${i}`).join(', ');
const table = EXTERNALS.map((e, i) => `${JSON.stringify(e)}: __ext${i}`).join(', ');
await esbuild.build({
  entryPoints: ['src/module.tsx'],
  outfile: path.join(out, 'module.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: EXTERNALS,
  jsx: 'transform',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  banner: {
    js: `define(${JSON.stringify(EXTERNALS)}, function (${args}) {
var __mods = { ${table} };
var require = function (n) { if (n in __mods) return __mods[n]; throw new Error("trace-pong: unknown module " + n); };
var module = { exports: {} }, exports = module.exports;`,
  },
  footer: { js: 'return module.exports;\n});' },
});

// static files; plugin.json gets its version from package.json
const meta = JSON.parse(fs.readFileSync('src/plugin.json', 'utf8'));
meta.info.version = pkg.version;
meta.info.updated = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(out, 'plugin.json'), JSON.stringify(meta, null, 2) + '\n');
fs.cpSync('src/img', path.join(out, 'img'), { recursive: true });
fs.copyFileSync('src/README.md', path.join(out, 'README.md'));
console.log(`built ${out} (${pkg.version})`);

if (zip) {
  fs.mkdirSync('dist', { recursive: true });
  for (const f of fs.readdirSync('dist')) if (f.startsWith(`${ID}-`) && f.endsWith('.zip')) fs.rmSync(path.join('dist', f));
  const file = path.join('dist', `${ID}-${pkg.version}.zip`);
  fs.writeFileSync(file, makeZip('build'));
  console.log(`wrote ${file}`);
}

// Minimal ZIP writer (deflate, no dependencies). Entries are paths relative to `dir`.
function makeZip(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const local = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(path.relative(dir, f).split(path.sep).join('/'));
    const raw = fs.readFileSync(f);
    const data = zlib.deflateRawSync(raw, { level: 9 });
    const crc = zlib.crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(dosTime, 10);
    head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28);
    local.push(head, name, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(0, 30);   // extra + comment length
    cen.writeUInt16LE(0, 34);   // disk
    cen.writeUInt16LE(0, 36);   // internal attrs
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38);   // external attrs: regular file, rw-r--r--
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += head.length + name.length + data.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
