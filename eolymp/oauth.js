const crypto = require('crypto');
const http = require('http');

const CLIENT = 'code';
const SCOPE = 'openid profile offline_access atlas:problem:read';
const AUTHORIZE = 'https://accounts.eolymp.com/authorize';
const API = 'https://api.eolymp.com/oauth2';

class Rejected extends Error {}

function random() {
  return crypto.randomBytes(32).toString('base64url');
}

function listen(state, pages) {
  let server;
  const code = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        res.writeHead(404).end();
        return;
      }
      const granted = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' }).end(granted ? pages.done : pages.failed);
      if (granted) resolve(granted);
      else reject(new Rejected(url.searchParams.get('error_description') || url.searchParams.get('error') || 'no code'));
    });
    server.on('error', reject);
  });
  code.catch(() => {});
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      redirect: `http://127.0.0.1:${server.address().port}/callback`,
      code,
      close: () => server.close(),
    }));
  });
}

async function post(path, fields) {
  const res = await fetch(`${API}/${path}`, { method: 'POST', body: new URLSearchParams(fields) });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  if ([400, 401, 403].includes(res.status)) throw new Rejected(body.message || `HTTP ${res.status}`);
  throw new Error(body.message || `HTTP ${res.status}`);
}

function session(body, refresh) {
  return { access: body.access_token, refresh: body.refresh_token || refresh, expires: Date.now() + (body.expires_in || 0) * 1000 };
}

async function signIn({ open, pages, lang, cancelled }) {
  const state = random();
  const verifier = random();
  const local = await listen(state, pages);
  try {
    const query = {
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: local.redirect,
      scope: SCOPE,
      state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      lang,
    };
    if (!await open(`${AUTHORIZE}?${Object.entries(query).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}`)) return undefined;
    const code = await Promise.race([local.code, cancelled]);
    if (!code) return undefined;
    return session(await post('token', { grant_type: 'authorization_code', client_id: CLIENT, code, code_verifier: verifier, redirect_uri: local.redirect }));
  } finally {
    local.close();
  }
}

async function refresh(kept) {
  if (!kept.refresh) throw new Rejected('session expired');
  return session(await post('token', { grant_type: 'refresh_token', client_id: CLIENT, refresh_token: kept.refresh }), kept.refresh);
}

async function revoke(kept) {
  await post('revoke', { token: kept.refresh || kept.access });
}

async function userinfo(access) {
  const res = await fetch(`${API}/userinfo`, { headers: { Authorization: `Bearer ${access}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

module.exports = { Rejected, listen, signIn, refresh, revoke, userinfo };
