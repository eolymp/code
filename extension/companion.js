const http = require('http');

const BODY_LIMIT = 1 << 20;
const TEST_LIMIT = 100;

function webUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && value.length <= 2000 ? value : undefined;
}

function parse(body) {
  const data = JSON.parse(body);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the message is not a problem');
  const text = (value) => (typeof value === 'string' ? value.slice(0, 200) : undefined);
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const tests = (Array.isArray(data.tests) ? data.tests : [])
    .filter((t) => t && typeof t.input === 'string' && typeof t.output === 'string')
    .slice(0, TEST_LIMIT)
    .map((t) => ({ input: t.input, output: t.output }));
  return {
    name: text(data.name) || '',
    tests,
    meta: { name: text(data.name), group: text(data.group), url: webUrl(data.url), timeLimit: number(data.timeLimit), memoryLimit: number(data.memoryLimit) },
  };
}

function fromBrowserExtension(req) {
  const origin = req.headers.origin;
  return origin === undefined || /^(chrome|moz|safari-web)-extension:\/\//.test(origin);
}

function listen(port, onProblem, onError) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !fromBrowserExtension(req)) {
      res.statusCode = 403;
      res.end();
      req.destroy();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > BODY_LIMIT) req.destroy();
      else chunks.push(d);
    });
    req.on('error', () => {});
    req.on('end', () => {
      res.end();
      try {
        onProblem(parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        onError(err);
      }
    });
  });
  server.on('error', () => {});
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { listen, parse, webUrl };
