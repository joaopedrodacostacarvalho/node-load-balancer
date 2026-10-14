const http = require('http');
const os = require('os');

const PORT = Number(process.env.PORT) || 3001;
const INSTANCE_ID = process.env.INSTANCE_ID || `app-${PORT}`;

// Cores por instância — basta mudar INSTANCE_ID para ter cor nova
const PALETTE = ['#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#e53935', '#00897b'];
function colorFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const COLOR = colorFor(INSTANCE_ID);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }

  // Cabeçalho de identificação — verificação por curl -I
  res.setHeader('X-Served-By', INSTANCE_ID);

  const html = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>${INSTANCE_ID}</title></head>
<body style="margin:0;font-family:system-ui;background:${COLOR};color:#fff">
  <main style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;text-align:center">
    <h1 style="font-size:4rem;margin:0">Respondido por: ${INSTANCE_ID}</h1>
    <p style="font-size:1.4rem;opacity:.9">hostname: ${os.hostname()}</p>
    <p style="font-size:1.2rem;opacity:.85">porta: ${PORT} &middot; ${new Date().toISOString()}</p>
  </main>
</body></html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => console.log(`[${INSTANCE_ID}] escutando na porta ${PORT}`));
