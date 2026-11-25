const HOSTS = ['eolymp.com', 'www.eolymp.com'];
const BASE = 'https://api.eolymp.com/spaces/00000000-0000-0000-0000-000000000000';

function numberIn(query) {
  if (!URL.canParse(query)) return undefined;
  const url = new URL(query);
  const found = url.pathname.match(/^(?:\/[a-z]{2})?\/problems\/(\d+)(?:\/|$)/);
  return HOSTS.includes(url.hostname) && found ? Number(found[1]) : undefined;
}

async function get(token, route, input) {
  const query = input ? `?${new URLSearchParams({ q: JSON.stringify(input) })}` : '';
  const res = await fetch(`${BASE}${route}${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
}

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

module.exports = { numberIn, get, text };
