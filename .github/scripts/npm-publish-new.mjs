#!/usr/bin/env node
// The publish step of the release workflow.
//
// npm refuses any version it already serves, so a plain `npm publish` (or `--workspaces`) fails the whole job on a
// retry after a partial publish and on a workspace that was not bumped. This publishes each public package version
// npm lacks, with provenance, and skips a version npm already serves with exactly the contents `npm pack` makes here
// (same integrity); the same version with other contents fails. Every package is tried, so a retry finishes the rest,
// and every failure is named. The skipped versions go to --out (already-published.json) and the step summary.
//
// Usage in the publish job (permissions: id-token: write; npm 11 for trusted publishing):
//   node .github/scripts/npm-publish-new.mjs [--dir .] [--out already-published.json]
// It reads only public registry metadata; npm publish authenticates through the workflow's OIDC token.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {publicPackages} from './npm-trust-proof.mjs';

const REGISTRY = 'https://registry.npmjs.org';

const run = (cmd, args, opts) => spawnSync(cmd, args, {...opts, encoding: 'utf8'});

export async function publishNew({dir = '.', fetchFn = fetch, exec = run, registry = REGISTRY, out = ''} = {}) {
  const r = {published: [], skipped: [], failed: [], ok: true};
  for (const pkg of publicPackages(dir)) {
    const id = `${pkg.name}@${pkg.version}`;
    const cwd = path.join(dir, pkg.dir);
    let res;
    try {
      res = await fetchFn(`${registry}/${pkg.name.replace('/', '%2f')}/${pkg.version}`);
    } catch (e) {
      r.failed.push(`${id}: npm could not be read (${e.message})`);
      continue;
    }
    if (res.status === 200) {
      const served = (await res.json())?.dist?.integrity || '';
      const packed = exec('npm', ['pack', '--dry-run', '--json'], {cwd});
      let mine = '';
      try { mine = JSON.parse(packed.stdout || '[]')[0]?.integrity || ''; } catch { mine = ''; }
      if (packed.status === 0 && mine && mine === served) r.skipped.push(id);
      else r.failed.push(`${id}: npm already has this version with other contents; raise the version`);
      continue;
    }
    if (res.status !== 404) {
      r.failed.push(`${id}: npm answered ${res.status}`);
      continue;
    }
    const pub = exec('npm', ['publish', '--provenance', '--access', 'public'], {cwd});
    if (pub.status === 0) r.published.push(id);
    else r.failed.push(`${id}: npm publish failed: ${String(pub.stderr || pub.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  }
  r.ok = r.failed.length === 0;
  if (out) fs.writeFileSync(out, JSON.stringify(r.skipped) + '\n');
  return r;
}

export function summary(r) {
  const rows = [...r.published.map((p) => `| ${p} | published |`), ...r.skipped.map((p) => `| ${p} | already published, same contents |`),
    ...r.failed.map((f) => `| ${f.split(': ')[0]} | ${f.split(': ').slice(1).join(': ')} |`)];
  return ['| package | result |', '|---|---|', ...rows].join('\n') + '\n';
}

const isMain = () => {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
};

if (isMain()) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const r = await publishNew({dir: arg('--dir', '.'), out: arg('--out', 'already-published.json')});
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(r));
  console.log(JSON.stringify(r, null, 1));
  process.exit(r.ok ? 0 : 1);
}
