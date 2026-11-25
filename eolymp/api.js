const fs = require('fs');
const path = require('path');

const SITES = { 'eolymp.com': 'https://api.eolymp.com/spaces/00000000-0000-0000-0000-000000000000' };
const LINK = 'problem.json';
const JUDGE = 'eolymp';
const FAMILIES = { '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.py': 'python' };

function numberIn(query) {
  if (!URL.canParse(query)) return undefined;
  const url = new URL(query);
  const found = url.pathname.match(/^(?:\/[a-z]{2})?\/problems\/(\d+)/);
  return SITES[url.hostname.replace(/^www\./, '')] && found ? Number(found[1]) : undefined;
}

function linkOf(file) {
  const kept = path.join(path.dirname(file), LINK);
  if (!FAMILIES[path.extname(file).toLowerCase()] || !fs.existsSync(kept)) return undefined;
  try {
    const link = JSON.parse(fs.readFileSync(kept, 'utf8'));
    const site = new URL(link.url).hostname;
    return link.judge === JUDGE && link.id && SITES[site] ? { site, problem: String(link.id), url: link.url } : undefined;
  } catch {
    return undefined;
  }
}

function familyOf(file) {
  return FAMILIES[path.extname(file).toLowerCase()];
}

async function call(site, token, method, route, input) {
  const query = method === 'GET' && input ? `?${new URLSearchParams({ q: JSON.stringify(input) })}` : '';
  const res = await fetch(`${SITES[site]}${route}${query}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(input || {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
}

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

module.exports = { LINK, JUDGE, numberIn, linkOf, familyOf, call, text };
