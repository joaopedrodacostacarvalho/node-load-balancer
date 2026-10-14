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
// Versão suave da mesma cor (10% de opacidade) para o fundo do badge
const SOFT = COLOR + '1a'; // "1a" = 10% alpha em hex

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
<head>
  <meta charset="utf-8">
  <title>${INSTANCE_ID}</title>
  <link rel="icon" href="data:,">
</head>
<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f7f8fa;color:#1f2328;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box">

  <main style="background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.05);max-width:560px;width:100%;padding:40px 32px;text-align:center">

    <!-- Bloco de destaque: só ele carrega a cor da instância -->
    <div style="display:inline-flex;align-items:center;gap:10px;background:${SOFT};color:${COLOR};padding:8px 16px;border-radius:999px;font-weight:600;font-size:1rem;border:1px solid ${COLOR}33">
      <span style="width:10px;height:10px;border-radius:50%;background:${COLOR};display:inline-block"></span>
      Respondido por: ${INSTANCE_ID}
    </div>

    <h1 style="font-size:1.75rem;font-weight:600;margin:24px 0 8px;color:#1f2328">
      Load Balancer Demo
    </h1>
    <p style="margin:0;color:#656d76;font-size:.95rem">
      Recarregue a página (Ctrl+F5) para ver a alternância entre instâncias.
    </p>

    <dl style="margin:32px 0 0;display:grid;grid-template-columns:auto 1fr;gap:8px 16px;text-align:left;font-size:.9rem;color:#656d76;border-top:1px solid #eaeef2;padding-top:20px">
      <dt style="font-weight:500">Hostname:</dt><dd style="margin:0;color:#1f2328;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${os.hostname()}</dd>
      <dt style="font-weight:500">Porta:</dt><dd style="margin:0;color:#1f2328;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${PORT}</dd>
      <dt style="font-weight:500">Horário:</dt><dd style="margin:0;color:#1f2328;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${new Date().toISOString()}</dd>
    </dl>

  </main>
</body>
</html>`;

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(PORT, () => console.log(`[${INSTANCE_ID}] escutando na porta ${PORT}`));
