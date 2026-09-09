import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
function wrangler(args, json = false) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8', stdio: json ? 'pipe' : 'inherit',
    env: {...process.env, WRANGLER_SEND_METRICS: 'false'},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (json) process.stderr.write(result.stderr || result.stdout);
    throw new Error('Uzak veritabanı geçişi tamamlanamadı. Yeniden çalıştırmadan önce hatayı inceleyin.');
  }
  return json ? JSON.parse(result.stdout) : null;
}

// D1's remote query endpoint can split trigger bodies differently from SQLite.
// File import preserves complete SQL and rolls back the import on failure.
wrangler(['d1', 'execute', 'DB', '--remote', '--command',
  'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)', '--json'], true);
const result = wrangler(['d1', 'execute', 'DB', '--remote', '--command',
  'SELECT name FROM d1_migrations ORDER BY id', '--json'], true);
const applied = new Set(result.flatMap(row => row.results).map(row => row.name));
const pending = readdirSync(join(root, 'migrations')).filter(name => /^\d+_[\w-]+\.sql$/.test(name) && !applied.has(name)).sort();
if (!pending.length) {
  console.log('Tüm veritabanı geçişleri uygulanmış.');
} else {
  const directory = mkdtempSync(join(tmpdir(), 'lunapot-migration-'));
  try {
    for (const name of pending) {
      const sql = readFileSync(join(root, 'migrations', name), 'utf8').replace(/\r\n/g, '\n');
      const file = join(directory, name);
      writeFileSync(file, sql + '\nINSERT INTO d1_migrations(name) VALUES(\'' + name + '\');\n');
      console.log('Uygulanıyor: ' + name);
      wrangler(['d1', 'execute', 'DB', '--remote', '--file', file, '--yes']);
    }
  } finally {
    // Remove only the files this run created, without recursive deletion.
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  }
}
