const http = require('http');
const port = process.argv[2] || 3001;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Hello from backend instance',
    port: port,
    timestamp: new Date()
  }));
});

server.listen(port, () => {
  console.log(`Backend server escutando na porta ${port}`);
});
