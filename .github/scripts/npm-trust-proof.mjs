#!/usr/bin/env node
// Proves, without publishing, that npm trusts this workflow for every public package of the repo.
//
// npm binds a GitHub trusted publisher to owner, repository, workflow filename and an optional environment; the
// trigger event is not part of it (docs.npmjs.com/trusted-publishers). So a workflow_dispatch job inside the same
// release.yml asks GitHub for an OIDC id token with audience npm:registry.npmjs.org and posts it to npm's exchange
// endpoint, POST /-/npm/v1/oidc/token/exchange/package/<name>, the same call npm publish makes first
// (npm 11.21.3 lib/utils/oidc.js). A 201 with a token means a publish from this workflow would authenticate; the
// token is a short-lived credential for that one package and is dropped at once, never printed or stored.
// Not proven by the exchange: the publisher's "allowed actions" (publish vs stage publish), checked at publish time;
// `npm trust list <package>` shows them.
//
// Usage on a runner (job permissions: id-token: write, contents: read):
//   node npm-trust-proof.mjs [--dir .] [--out npm-trust-proof.json]
// Exit 0 only when every public package exchanged; the JSON and the step summary carry one row per package.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org';
const AUDIENCE = 'npm:registry.npmjs.org';

// the repo's public packages: the root, or every workspace whose package.json is not private
export function publicPackages(dir, read = (p) => JSON.parse(fs.readFileSync(p, 'utf8')), list = fs.readdirSync) {
  const root = read(path.join(dir, 'package.json'));
  const patterns = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages || [];
  const dirs = [];
  for (const pat of patterns) {
    if (pat.endsWith('/*')) {
      const base = path.join(dir, pat.slice(0, -2));
      let names = [];
      try { names = list(base); } catch { names = []; }
      for (const n of names.sort()) dirs.push(path.join(base, n));
    } else dirs.push(path.join(dir, pat));
  }
  const out = [];
  for (const d of patterns.length ? dirs : [dir]) {
    let pkg;
    try { pkg = read(path.join(d, 'package.json')); } catch { continue; }
    if (pkg.private === true || !pkg.name || !pkg.version) continue;
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    out.push({ name: pkg.name, version: pkg.version, dir: path.relative(dir, d) || '.', repository: repo });
  }
  return out;
}

// GitHub's OIDC id token for npm's audience; the request token and the id token are never printed
export async function idToken(env = process.env, fetchFn = fetch) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new Error('no OIDC request token: the job needs permissions id-token: write');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.append('audience', AUDIENCE);
  const r = await fetchFn(url.href, { headers: { Accept: 'application/json', Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!r.ok) throw new Error(`GitHub refused the OIDC id token request (${r.status})`);
  const body = await r.json();
  if (typeof body?.value !== 'string' || !body.value) throw new Error('GitHub returned no OIDC id token');
  return body.value;
}

const WHY = {
  400: 'npm refused the id token as malformed',
  401: 'npm did not accept the id token (audience or signature)',
  403: 'npm has no trusted publisher for this owner, repository, workflow file or environment',
  404: 'no trusted publisher on npm for this package, or its configuration expired unvalidated (2 days), or the package does not exist yet',
};

// one package: the exchange (201 + token = trusted) and whether this version is still free on npm
// npm's provenance refuses a publish whose package.json repository.url is not the GitHub repository it runs in
export function repoMatches(url, ghRepo) {
  if (!ghRepo) return true;
  const m = String(url || '').match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?(?:[#/].*)?$/i) || String(url || '').match(/^github:([^/]+\/[^/#]+)$/i);
  return Boolean(m) && m[1].toLowerCase() === ghRepo.toLowerCase();
}

export async function provePackage(pkg, token, fetchFn = fetch, registry = REGISTRY) {
  const name = encodeURIComponent(pkg.name).replace(/^%40/, '@');
  let status = 0, trusted = false, why = '';
  try {
    const r = await fetchFn(`${registry}/-/npm/v1/oidc/token/exchange/package/${name}`, {
      method: 'POST', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    status = r.status;
    let body = {};
    try { body = await r.json(); } catch { body = {}; }
    trusted = r.ok && typeof body?.token === 'string' && body.token.length > 0;
    // the exchanged token is a live credential: nothing keeps or prints it
    body = null;
    if (!trusted) why = WHY[status] || (r.ok ? 'npm answered without a token' : `npm answered ${status}`);
  } catch (e) {
    why = `exchange request failed: ${e?.cause?.code || e?.name || 'network error'}`;
  }
  let versionFree = null;
  try {
    const v = await fetchFn(`${registry}/${name}/${encodeURIComponent(pkg.version)}`, { headers: { Accept: 'application/json' } });
    versionFree = v.status === 404 ? true : v.ok ? false : null;
  } catch { versionFree = null; }
  return { name: pkg.name, version: pkg.version, dir: pkg.dir, trusted, status, why, version_free: versionFree };
}

export async function prove({ dir = '.', env = process.env, fetchFn = fetch } = {}) {
  const pkgs = publicPackages(dir);
  const result = {
    at: new Date().toISOString(),
    repository: env.GITHUB_REPOSITORY || '', workflow_ref: env.GITHUB_WORKFLOW_REF || '', sha: env.GITHUB_SHA || '',
    event: env.GITHUB_EVENT_NAME || '', packages: [], ok: false,
  };
  if (!pkgs.length) { result.why = 'no public package found'; return result; }
  let token;
  try { token = await idToken(env, fetchFn); } catch (e) { result.why = e.message; return result; }
  for (const p of pkgs) {
    const row = await provePackage(p, token, fetchFn);
    row.repository_matches = repoMatches(p.repository, env.GITHUB_REPOSITORY);
    if (!row.repository_matches) {
      row.why = [row.why, `repository.url ${p.repository ? `"${p.repository}"` : 'missing'} is not github.com/${env.GITHUB_REPOSITORY}: provenance refuses the publish`].filter(Boolean).join('; ');
    }
    result.packages.push(row);
  }
  token = null;
  result.ok = result.packages.every((p) => p.trusted && p.repository_matches);
  return result;
}

export function summary(r) {
  const rows = r.packages.map((p) => `| ${p.name} | ${p.version} | ${p.trusted ? 'trusted' : 'NOT trusted'} | ${p.version_free === true ? 'free' : p.version_free === false ? 'already published' : 'unknown'} | ${p.why || ''} |`);
  return [`### npm trust proof: ${r.ok ? 'every package trusted' : 'not proven'}`, r.why ? `\n${r.why}\n` : '',
    '| package | version | exchange | version on npm | why |', '|---|---|---|---|---|', ...rows, ''].join('\n');
}

// run as a script (also from a path with spaces or through a symlink), not when imported by a test
export const isMain = (argv1 = process.argv[1]) => {
  try { return Boolean(argv1) && import.meta.url === pathToFileURL(fs.realpathSync(argv1)).href; } catch { return false; }
};

if (isMain()) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
  const r = await prove({ dir: arg('--dir', '.') });
  fs.writeFileSync(arg('--out', 'npm-trust-proof.json'), JSON.stringify(r, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(r));
  console.log(summary(r));
  process.exit(r.ok ? 0 : 1);
}
