# Load Balancer Simples Usando Node.js (HTTP + proxy reverso + round-robin)

Demonstração de balanceamento de carga com 3 instâncias de uma
aplicação simples de web atrás de um proxy reverso que implementa round-robin e
health check ativo.


## 1. Visão geral

```
                     ┌─────────────────────┐
   navegador  ───▶   │  Load Balancer :8080 │  ◀── único ponto de entrada
   curl              │  (src/loadBalancer)  │
                     └──────────┬──────────┘
                                │  round-robin
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
        ┌──────────┐      ┌──────────┐      ┌──────────┐
        │ app-01   │      │ app-02   │      │ app-03   │
        │ :3001    │      │ :3002    │      │ :3003    │
        └──────────┘      └──────────┘      └──────────┘
          (backend.js)     (backend.js)     (backend.js)
```

- Para o teste acessamos apenas o `http://localhost:8080`.
- As três instâncias são processos independentes, com `PORT` e `INSTANCE_ID`
  próprios.
- O balanceador é o único componente que conhece a instâncias; elas  não se enxergam.


## 2. Proxy Reverso

Proxy reverso é um intermediário que fica na frente de um ou mais
servidores e recebe requisições em nome deles. O cliente não sabe 
qual servidor real respondeu, pois ele só vai conversar com o proxy.

### Onde isso aparece no código

Em `src/loadBalancer.js`, o proxy reverso está em `handleProxy`:

```js
const proxyReq = http.request({
  hostname: url.hostname,
  port: url.port,
  path: req.url,
  method: req.method,
  headers: { ...req.headers, 'X-Forwarded-For': ..., 'X-Proxy-By': ... }
}, (proxyRes) => {
  res.writeHead(proxyRes.statusCode, proxyRes.headers);
  proxyRes.pipe(res);
});

req.pipe(proxyReq);
```

O que essa função faz:

1. Recebe a requisição do cliente (`req`).
2. Abre uma nova conexão com o backend escolhido (`proxyReq`).
3. Replica método, path e headers, pois é uma requisição nova, não um
   encaminhamento.
4. Faz streaming do corpo nos dois sentidos (`req.pipe(proxyReq)` e
   `proxyRes.pipe(res)`), o que funciona inclusive para payloads grandes.
5. Devolve os headers do backend para o cliente, por isso que o
   `X-Served-By` chega intacto em quem consome o `:8080`.

### Efeitos colaterais que o proxy reverso precisa tratar

- `X-Forwarded-For`: como o backend vê o IP do Load Balancer, não do cliente, o
  proxy injeta essa informação. No código:
  ```js
  'X-Forwarded-For': (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + req.socket.remoteAddress
  ```
  Concatenar (em vez de sobrescrever) preserva a cadeia se já houver outro
  proxy à frente.

- Timeouts: se o backend travar, o proxy precisa cortar sozinho senão o
  cliente fica pendurado. Aqui:
  ```js
  proxyReq.setTimeout(REQUEST_TIMEOUT, () => {
    target.healthy = false;
    proxyReq.destroy(new Error('timeout'));
  });
  ```

- Re-roteamento em falha: quando a conexão com o backend cai antes de
  enviar headers, o proxy pode tentar outro servidor — mas só para métodos
  idempotentes (GET/HEAD/OPTIONS), porque repetir um POST pode duplicar
  efeitos:
  ```js
  const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (!res.headersSent && idempotent) return handleProxy(req, res, attempt + 1);
  ```


## 3. O Round-Robin

Round-robin é a política de distribuição mais simples: cada requisição vai
para o próximo servidor da lista, em ciclo. Com 3 servidores saudáveis, a
sequência é `1 → 2 → 3 → 1 → 2 → 3 …`.

### Vantagens
- Mais simples de implementar e debugar.
- Distribuição uniforme quando os backends têm capacidade parecida.

### Desvantagens
- Não considera carga: um servidor lento continua recebendo a mesma fatia. 
  Possível solução seria o weighted round-robin, onde temos 'pesos' para definir maior ou menor 
  capacidade de processamento.
- Não considera saúde por si só: precisa ser combinado com um health
  check.
- Não resolve sessão em memória: como cada requisição pode cair numa
  instância diferente, qualquer estado guardado no processo some quando clicamos novamente.
  Uma possível solução: sticky sessions (afinidade por cookie
  ou IP) ou armazenamento externo (Redis, banco).

### Onde isso foi usado

O ponteiro global `current` e a função `getNextHealthyServer`:

```js
let current = 0;

function getNextHealthyServer() {
  const n = servers.length;
  for (let i = 0; i < n; i++) {
    const idx = (current + i) % n;
    if (servers[idx].healthy) { current = (idx + 1) % n; return servers[idx]; }
  }
  return null;
}
```

- `current` guarda de quem será a próxima vez.
- `(current + i) % n` percorre a lista circularmente, começando do próximo.
- Ao encontrar um servidor `healthy`, avança `current` e devolve o
  escolhido daí, mesmo que instâncias fiquem fora e voltem, a sequência
  continua sendo rotativa entre as que estão no ar.
- Se todos estiverem `healthy === false`, retorna `null` e o caller
  devolve 503 Service Unavailable (não fica em loop).

### A lista de backends vem de variável de ambiente

Pegamos a lista de backends pelo env

```js
const servers = (process.env.BACKENDS
  || 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
  .split(',').map(u => ({ url: u.trim(), healthy: true, activeConnections: 0 }));
```

Isso significa que subir uma 4ª instância não exige mexer no código, já que é só
relançar o Load Balancer com uma `BACKENDS` maior.


## Health Check Ativo

Round-robin sozinho não sabe se um backend morreu, pois ele só descobre quando
tenta e falha. Para evitar mandar tráfego a servidores mortos, há um
health check que roda com a cada X tempo:

```js
setInterval(() => servers.forEach(checkServerHealth), HEALTH_CHECK_INTERVAL);
```

`checkServerHealth` faz `GET /health` em cada instância, com timeout de 3s:

```js
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
```

Consequências importantes:

- Quando um servidor morre, ele é marcado como unhealthy em até ~10s (o
  intervalo) ou imediatamente se o próprio proxy falhar ao falar com ele.
- Quando volta, o próximo ciclo o reintegra automaticamente, já que não precisa
  reiniciar o Load Balancer.
- O health check é ativo (o Load Balancer vai até o backend), não passivo.


## 5. Pré-requisitos

- Node.js ≥ 18 (`node -v`).
- `npm`.

Nenhuma dependência de runtime é necessária apenas `concurrently` e
`cross-env` como devDependencies, só para orquestrar os 4 processos em um
comando.


## 6. SETUP

```bash
npm install
npm start
```

`npm start` executa:

```
concurrently -k -n app1,app2,app3,lb \
  "npm:start:app1" "npm:start:app2" "npm:start:app3" "npm:start:lb"
```

O que isso faz:
- 3 instâncias em portas 3001/3002/3003 com `INSTANCE_ID` distintos
  (`app-01`, `app-02`, `app-03`).
- 1 balanceador em `:8080`.
- Flag `-k` = kill others: se um processo morre, os outros são encerrados
  (útil no `Ctrl+C` para fechar).

Saída esperada:

```
[app1] [app-01] escutando na porta 3001
[app2] [app-02] escutando na porta 3002
[app3] [app-03] escutando na porta 3003
[lb]   Load balancer está rodando na porta 8080
```

Abra `http://localhost:8080` no navegador.

## 7. Como verificar

Abra `http://localhost:8080` e use Ctrl+F5 (evita cache). O ciclo é
`app-01 → app-02 → app-03 → app-01 …`.

### 7.2 Cabeçalho HTTP (`X-Served-By`)

```bash
for i in $(seq 1 10); do
  curl -sI http://localhost:8080 | grep -i x-served-by
done
```

Esperado: três valores alternando.

### 7.3 Distribuição em volume

```bash
for i in $(seq 1 100); do
  curl -sI http://localhost:8080 | grep -i x-served-by
done | sort | uniq -c
```

Esperado: ~33/33/34 por instância.

### 7.4 Tolerância a falhas

1. Mate uma instância (`Ctrl+C` num dos painéis do `concurrently`, ou
   `taskkill`/`pkill` no processo `backend.js` daquela porta).
2. Repita 7.3 — o `X-Served-By` correspondente vai sumir.
3. Suba a instância de novo (`npm run start:app2`, por exemplo) e mostre que
   ela volta a aparecer em até 10s ( por causa do intervalo do health check).

### 7.5 Escala (4ª instância)

```bash
# janela 1: nova instância
PORT=3004 INSTANCE_ID=app-04 node src/backend.js
# janela 2: reinicia o LB passando a BACKENDS atualizada
BACKENDS="http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost:3004" \
  node src/loadBalancer.js
```

Confirme com 7.3 que `app-04` aparece na contagem.

### 7.6 Prova negativa (o Load Balancer é quem alterna, não a app)

```bash
for i in $(seq 1 5); do curl -sI http://localhost:3002 | grep -i x-served-by; done
```

Esperado: sempre `app-02`. Para ver a alternância vinda do balanceador.

### 7.7 Logs

Enquanto roda 7.3, o terminal do LB imprime uma linha por requisição:

```
[LB] GET / -> http://localhost:3001 (200)
[LB] GET / -> http://localhost:3002 (200)
[LB] GET / -> http://localhost:3003 (200)
```

## 8. Estrutura do repositório

```
node-load-balancer/
├── src/
│   ├── backend.js        # app web (HTML + X-Served-By + /health)
│   └── loadBalancer.js   # proxy reverso + round-robin + health check
├── package.json          # scripts de orquestração
└── README.md
```

## 9. Limitações 

- Estado em memória não sobrevive à alternância. Se a app guardasse
  sessão de usuário no processo, o usuário "perderia" o login a cada
  requisição que caísse em outra instância. Solução: sticky sessions (cookie
  ou IP) ou store externo (Redis, DB).
- Round-robin ignora latência e carga. Um backend lento recebe a mesma
  fatia. Alternativas: `least_conn`, weighted RR, ou algoritmos adaptativos.
- Health check tem janela de até `HEALTH_CHECK_INTERVAL`. Uma instância
  que morre logo após um check pode receber tráfego por até ~10s antes de ser
  excluída — mitigado pelo fato de o próprio proxy marcar unhealthy ao
  detectar erro de conexão.
- O balanceador é um SPOF (Single Point of Failure). Se o `:8080` cair, o serviço cai. Em produção,
  rodariam pelo menos 2 Load Balancers.
- Sem TLS, sem HTTP/2, sem rate limiting, 
  Tudo isso existe no NGINX e pode ser uma evolução deste projeto.
