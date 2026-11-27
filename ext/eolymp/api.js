const HOSTS = ['eolymp.com', 'www.eolymp.com'];
const BASE = 'https://api.eolymp.com/spaces/00000000-0000-0000-0000-000000000000';

function numberIn(query) {
  if (!URL.canParse(query)) return undefined;
  const url = new URL(query);
  const found = url.pathname.match(/^(?:\/[a-z]{2})?\/problems\/(\d+)(?:\/|$)/);
  return HOSTS.includes(url.hostname) && found ? Number(found[1]) : undefined;
}

function contestIn(query) {
  if (!URL.canParse(query)) return undefined;
  const url = new URL(query);
  const found = url.pathname.match(/^(?:\/[a-z]{2})?\/contests\/([\w-]+)(?:\/|$)/);
  return HOSTS.includes(url.hostname) && found ? found[1] : undefined;
}

async function get(token, route, input) {
  const query = input ? `?${new URLSearchParams({ q: JSON.stringify(input) })}` : '';
  const res = await fetch(`${BASE}${route}${query}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status });
  return body;
}

async function post(token, route, input) {
  const res = await fetch(`${BASE}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message || `HTTP ${res.status}`), { status: res.status });
  return body;
}

async function* events(chunks) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const lines = buffer.slice(0, end).split('\n');
      buffer = buffer.slice(end + 2);
      const field = (name) => lines.filter((line) => line.startsWith(`${name}:`)).map((line) => line.slice(name.length + 1).replace(/^ /, ''));
      const [event] = field('event');
      const data = field('data').join('\n');
      if (!data) continue;
      if (event === 'eof') return;
      if (event === 'error') throw new Error(JSON.parse(data).message || 'stream failed');
      yield JSON.parse(data);
    }
  }
  throw new Error('stream closed unexpectedly');
}

async function stream(token, route, input, signal) {
  const res = await fetch(`${BASE}${route}?${new URLSearchParams({ q: JSON.stringify(input) })}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
  return events(res.body);
}

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

module.exports = { numberIn, contestIn, get, post, events, stream, text };
