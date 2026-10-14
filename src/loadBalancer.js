const http = require('http');
const { URL } = require('url');

const PORT = 8080;
const HEALTH_CHECK_INTERVAL = 10000 // 10 segundos
const REQUEST_TIMEOUT = 5000; // 5 segundos

const servers = (process.env.BACKENDS
  || 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
  .split(',').map(u => ({ url: u.trim(), healthy: true, activeConnections: 0 }));


let current = 0;

function getNextHealthyServer() {
  const n = servers.length;
  for (let i = 0; i < n; i++) {
    const idx = (current + i) % n;
    if (servers[idx].healthy) { current = (idx + 1) % n; return servers[idx]; }
  }
  return null;
}

/**
 * @param {Request} req
 * @param {http.ServerResponse} res 
 */
function handleProxy(req, res, attempt = 0) {
  if (attempt >= servers.length) {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('Nenhum backend disponível');
  }

  const target = getNextHealthyServer();
  if (!target) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('Nenhum backend disponível');
  }

  const url = new URL(target.url);
  target.activeConnections++;

  let settled = false;
  const finish = () => { if (!settled) { settled = true; target.activeConnections--; } };

  const proxyReq = http.request({
    hostname: url.hostname,
    port: url.port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'X-Forwarded-For': (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + req.socket.remoteAddress,
      'X-Proxy-By': 'NodeJS-LB-Simples'
    }
  }, (proxyRes) => {
    console.log(`[LB] ${req.method} ${req.url} -> ${target.url} (${proxyRes.statusCode})`);
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    proxyRes.on('end', finish);
    proxyRes.on('error', (err) => {
      console.warn(`[ProxyRes Error] ${target.url}: ${err.message}`);
      finish();
      if (!res.writableEnded) res.end();
    });
  });

  proxyReq.setTimeout(REQUEST_TIMEOUT, () => {
    console.warn(`[Timeout] ${target.url}`);
    target.healthy = false;
    setImmediate(() => checkServerHealth(target));
    proxyReq.destroy(new Error('timeout'));
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy Error] ${target.url}: ${err.message}`);
    target.healthy = false;
    finish();

    // Só re-tenta se nada foi escrito ao cliente E o método é idempotente
    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!res.headersSent && idempotent) return handleProxy(req, res, attempt + 1);

    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain' });
    }
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
}
// Inicia o Load Balancer 
const server = http.createServer(handleProxy);
server.listen(PORT, () => {
  console.log(`Load balancer está rodando na porta ${PORT}`)
});

function checkServerHealth(server) {
  const url = new URL(`${server.url}/health`);
  const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
    res.resume();
    const ok = res.statusCode === 200;
    if (ok && !server.healthy) console.log(`[Recuperação] ${server.url}`);
    if (!ok && server.healthy) console.warn(`[Unhealthy] ${server.url} -> ${res.statusCode}`);
    server.healthy = ok;
  });
  req.setTimeout(3000, () => req.destroy(new Error('health timeout')));
  req.on('error', (err) => {
    if (server.healthy) console.warn(`[Unhealthy] ${server.url}: ${err.message}`);
    server.healthy = false;
  });
}

// Roda os checks de saúde periodicamente
setInterval(() => {
  //console.log('Rodando os health checks...');
  servers.forEach(checkServerHealth);
}, HEALTH_CHECK_INTERVAL);
