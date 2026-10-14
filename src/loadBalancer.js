const http = require('http');
const { URL } = require('url');

const PORT = 8080;
const HEALTH_CHECK_INTERVAL = 10000 // 10 segundos
const REQUEST_TIMEOUT = 5000; // 5 segundos

const servers = [
  { url: 'http://localhost:3001', healthy: true, activeConections: 0 },
  { url: 'http://localhost:3002', healthy: true, activeConections: 0 },
  { url: 'http://localhost:3003', healthy: true, activeConections: 0 }
];

let current = 0;

function getNextHealthyServer() {
  const initialIndex = current;

  while (true) {
    const server = servers[current];

    // O incremento para o próximo index volta para o início usando %
    current = (current + 1) % servers.length;

    if (server.healthy) {
      return server;
    }

    // Se checamos todos os servidores e nenhum está healthy retorna null
    if (current === initialIndex) {
      return null;
    }
  }
}

/**
 * @param {Request} req
 * @param {http.ServerResponse} res 
 */
function handleProxy(req, res) {
  const targetServer = getNextHealthyServer();

  if (!targetServer) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Serviço não disponível: Nenhum backend healthy disponível')
    return;
  }

  const targetUrl = new URL(targetServer.url);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      'X-Forwarded-For': req.socket.remoteAddress,
      'X-Proxy-By': 'NodeJS-LB-Simples'
    }
  };

  targetServer.activeConections++;

  const proxyReq = http.request(options, (proxyReq) => {

    res.writeHead(proxyReq.statusCode, proxyReq.headers);

    proxyReq.pipe(res, { end: true });

    proxyReq.on('end', () => {
      targetServer.activeConections--;
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy Error] Não foi possível alcançar o backend ${targetServer.url}: ${err.message}`);
    targetServer.activeConections--;

    // Triga um estado de falha para este servidor
    targetServer.healthy = false;

    // Tenta novamente com outro server
    handleProxy(req, res);
  })

  proxyReq.setTimeout(REQUEST_TIMEOUT, () => {
    console.error(`[Timeout] Backend ${targetServer.url} esgotou o tempo`);
    proxyReq.destroy();
    targetServer.healthy = false;
  });

  req.pipe(proxyReq, { end: true });
}

// Inicia o Load Balancer 
const server = http.createServer(handleProxy);
server.listen(PORT, () => {
  console.log(`Load balancer está rodando na porta ${PORT}`)
});

function checkServerHealth(server) {
  const targetUrl = new URL(`${server.url}/health`);

  const req = http.get({
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    path: targetUrl.pathname,
    timeout: 3000
  }, (res) => {
    if (res.statusCode === 200) {
      if (!server.healthy) {
        console.log(`[Recuperação] Backend recuperado: ${server.url}`);
        server.healthy = true;
      }
    } else {
      if (server.healthy) {
        console.warn(`[Unhealthy] Backend retornou status ${res.statusCode}: ${server.url}`);
        server.healthy = false;
      }
    }
    res.resume(); // Consumirá os dados de resposta para limpar memória
  });

  req.on('error', (err) => {
    if (server.healthy) {
      console.warn(`[Unhealthy] Backend falhou no check de saúde: ${server.url}: ${err.message}`);
      server.healthy = false;
    }
  });

  req.on('timeout', () => {
    if (server.healthy) {
      console.warn(`[Unhealthy] Backend deu time out: ${server.url}`);
      server.healthy = false;
    }
    req.destroy();
  });
}

// Roda os checks de saúde periodicamente
setInterval(() => {
  console.log('Rodando os health checks...');
  servers.forEach(checkServerHealth);
}, HEALTH_CHECK_INTERVAL);
