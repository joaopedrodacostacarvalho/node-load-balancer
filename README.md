# Load Balancer Simples Usando Node.js (HTTP + proxy reverso + round-robin)

Demonstração de balanceamento de carga com 3 instâncias de uma
aplicação web simples atrás de um proxy reverso que implementa round-robin e
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

- Para o teste acessamos apenas `http://localhost:8080`.
- As três instâncias são processos independentes, com `PORT` e `INSTANCE_ID`
  próprios.
- O balanceador é o único componente que conhece as instâncias; elas não se
  enxergam.


## 2. Proxy Reverso

Proxy reverso é um intermediário que fica na frente de um ou mais
servidores e recebe requisições em nome deles. O cliente não sabe qual
servidor real respondeu, pois só conversa com o proxy.

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
5. Devolve os headers do backend para o cliente, é por isso que o
   `X-Served-By` chega intacto em quem consome o `:8080`.

### Efeitos colaterais que o proxy reverso precisa tratar

- **`X-Forwarded-For`**: como o backend vê o IP do Load Balancer, não o do
  cliente, o proxy injeta essa informação:
  ```js
  'X-Forwarded-For': (req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'] + ', ' : '') + req.socket.remoteAddress
  ```
  Concatenar (em vez de sobrescrever) preserva a cadeia se já houver outro
  proxy à frente.

- **Timeouts**: se o backend travar, o proxy precisa cortar sozinho senão o
  cliente fica pendurado:
  ```js
  proxyReq.setTimeout(REQUEST_TIMEOUT, () => {
    target.healthy = false;
    proxyReq.destroy(new Error('timeout'));
  });
  ```

- **Re-roteamento em falha**: quando a conexão com o backend cai **antes**
  de enviar headers, o proxy pode tentar outro servidor, mas só para
  métodos idempotentes (GET/HEAD/OPTIONS), porque repetir um POST pode
  duplicar efeitos:
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
- **Não considera carga**: um servidor lento continua recebendo a mesma
  fatia. Possível solução: *weighted round-robin* (pesos por capacidade) ou
  *least-connections*.
- **Não considera saúde por si só**: precisa ser combinado com um health
  check.
- **Não resolve sessão em memória**: como cada requisição pode cair numa
  instância diferente, qualquer estado guardado no processo some na próxima
  requisição. Soluções: *sticky sessions* (afinidade por cookie ou IP) ou
  armazenamento externo (Redis, banco).

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
- Ao encontrar um servidor `healthy`, avança `current` e devolve o escolhido,
  mesmo que instâncias fiquem fora e voltem, a sequência continua rotativa
  entre as que estão no ar.
- Se **todos** estiverem `healthy === false`, retorna `null` e o chamador
  devolve `503 Service Unavailable` (não fica em loop).

### A lista de backends vem de variável de ambiente

```js
const servers = (process.env.BACKENDS
  || 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
  .split(',').map(u => ({ url: u.trim(), healthy: true, activeConnections: 0 }));
```

Subir uma 4ª instância não exige mexer no código, só precisa relançar o Load
Balancer com uma `BACKENDS` maior. (Veja o teste 7.5.)


## 4. Health Check Ativo

Round-robin sozinho não sabe se um backend morreu. Além disso, ele só descobre quando
tenta e falha. Para evitar mandar tráfego a servidores mortos, há um health
check periódico:

```js
setInterval(() => servers.forEach(checkServerHealth), HEALTH_CHECK_INTERVAL);
```

`checkServerHealth` faz `GET /health` em cada instância, com timeout de 3s:

```js
function checkServerHealth(backend) {
  const url = new URL(`${backend.url}/health`);
  const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname }, (res) => {
    res.resume();
    const ok = res.statusCode === 200;
    if (ok && !backend.healthy) console.log(`[Recuperação] ${backend.url}`);
    if (!ok && backend.healthy) console.warn(`[Unhealthy] ${backend.url} -> ${res.statusCode}`);
    backend.healthy = ok;
  });
  req.setTimeout(3000, () => req.destroy(new Error('health timeout')));
  req.on('error', (err) => {
    if (backend.healthy) console.warn(`[Unhealthy] ${backend.url}: ${err.message}`);
    backend.healthy = false;
  });
}
```

Consequências importantes:

- Quando um servidor morre, ele é marcado como *unhealthy* em até ~10 s (o
  intervalo do health check) **ou imediatamente** se o próprio proxy falhar
  ao falar com ele.
- Quando volta, o próximo ciclo o reintegra automaticamente e não precisa
  reiniciar o Load Balancer.
- O health check é **ativo** (o Load Balancer vai até o backend), não
  passivo.


## 5. Pré-requisitos

- **Node.js ≥ 18** (`node -v`).
- **npm**.
- Opcional, para o teste 7.3 (distribuição em volume):
  - **`hey`** — binário único, roda em Linux, macOS e Windows.
    - Instalação: `go install github.com/rakyll/hey@latest`
    - Ou via npm: `npm i -g hey` (wrapper)
    - Ou baixar binário pré-compilado do GitHub Releases.
  - **`curl`** — já vem com Linux/macOS; no Windows 10+ também está incluso.

Nenhuma dependência de runtime é necessária — apenas `concurrently` e
`cross-env` como devDependencies, só para orquestrar os múltiplos processos
em um comando.


## 6. Rodando o Projeto

```bash
npm install
npm start
```

`npm start` executa:

```
concurrently -n app1,app2,app3,lb \
  "npm:start:app1" "npm:start:app2" "npm:start:app3" "npm:start:lb"
```

O que isso faz:
- **3 instâncias** em portas 3001/3002/3003 com `INSTANCE_ID` distintos
  (`app-01`, `app-02`, `app-03`).
- **1 balanceador** em `:8080`, com `BACKENDS` apontando explicitamente
  para as três portas (portável em Linux, macOS e Windows — sem depender
  de sintaxe de shell específica).

Saída esperada:

```
[app1] [app-01] escutando na porta 3001
[app2] [app-02] escutando na porta 3002
[app3] [app-03] escutando na porta 3003
[lb]   Load balancer está rodando na porta 8080
```

Abra `http://localhost:8080` no navegador.

### Subir com 4 instâncias (usado no teste 7.5)

```bash
npm run start:4
```

Usamos o mesmo `concurrently`, mas chamando `start:app4` (porta 3004,
`INSTANCE_ID=app-04`) e `start:lb:4` (que já passa `BACKENDS` com a 3004
inclusa). Um comando, portável, sem erro de sintaxe de env.



## 7. Como verificar

Abra `http://localhost:8080` e use **Ctrl+F5** (evita cache). O ciclo é
`app-01 → app-02 → app-03 → app-01 …`.

### 7.1 Teste visual de alternância

A cada refresh (Ctrl+F5), a cor de fundo e o ID exibido mudam:

- `app-01` → azul (`#1e88e5`)
- `app-02` → verde (`#43a047`)
- `app-03` → laranja (`#fb8c00`)
- `app-04` → roxo (`#8e24aa`) aparece só no 7.5

A cor é derivada do `INSTANCE_ID` via `colorFor(id)`, então a mesma
instância **sempre** volta com a mesma cor — útil para reconhecer
visualmente que "aquela instância voltou" no teste 7.4.

### 7.2 Cabeçalho HTTP (`X-Served-By`)

```bash
for i in $(seq 1 10); do
  curl -sI http://localhost:8080 | grep -i x-served-by
done
```

Esperado: três valores alternando.

### 7.3 Distribuição em volume

**Forma recomendada — `hey` (portável em Linux, macOS e Windows):**

```bash
hey -n 100 -c 1 -disable-keepalive http://localhost:8080
```

Ao final, o `hey` imprime um resumo (latências, status codes). Como o
`X-Served-By` é específico por resposta, para contabilizar quem respondeu,
peça dump dos headers:

```bash
hey -n 100 -c 1 -disable-keepalive -o csv http://localhost:8080 > resp.csv
```

E conte a coluna `X-Served-By` do CSV. No Linux/macOS:

```bash
cut -d, -f<N> resp.csv | sort | uniq -c
```

(Descubra o índice `<N>` com `head -1 resp.csv`.)

**Alternativa simples em Linux / macOS (bash):**

```bash
for i in $(seq 1 100); do
  curl -sI http://localhost:8080 | grep -i x-served-by
done | sort | uniq -c
```

**Alternativa em Windows (PowerShell):**

```powershell
1..100 | ForEach-Object {
  (Invoke-WebRequest -Method Head http://localhost:8080).Headers['X-Served-By']
} | Group-Object | Select-Object Count, Name
```

Esperado (com 3 instâncias): ~33/33/34 por instância.

### 7.4 Tolerância a falhas

> **Não use `Ctrl+C` no terminal do `concurrently`** — o SIGINT é
> repassado a todos os filhos e derruba o LB junto. Mate **apenas** o
> processo da porta 3002, pelo sistema operacional.

**Linux / macOS:**
```bash
kill -9 $(lsof -i :3002 -t)
# ou, mais curto:
fuser -k 3002/tcp
```

**Windows (PowerShell):**
```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3002).OwningProcess -Force
```

**Windows (CMD):**
```cmd
netstat -ano | findstr :3002
taskkill /PID <PID_ENCONTRADO> /F
```

Depois:
1. Repita 7.3 e a contagem de `app-02` some.
2. Reative com `npm run start:app2` (em outro terminal).
3. Aguarde ≤10 s e repita 7.3 — `app-02` volta com ~33 requisições.

### 7.5 Escala (4ª instância)

Encerre o ambiente atual (`Ctrl+C` no terminal do `concurrently`) e suba o
arranjo com 4 instâncias em **um único comando**:

```bash
npm run start:4
```

Sob o capô: `app-01`..`app-04` nas portas 3001–3004, e o LB com `BACKENDS`
já incluindo a `3004`. Sem sintaxe de env específica de shell e funciona
igual em Linux, macOS e Windows.

Confirme com 7.3 que `app-04` aparece na contagem (~25/25/25/25).

### 7.6 Prova negativa (o Load Balancer é quem alterna, não a app)

**Linux / macOS:**
```bash
for i in $(seq 1 5); do curl -sI http://localhost:3002 | grep -i x-served-by; done
```

**Windows (PowerShell):**
```powershell
1..5 | ForEach-Object {
  (Invoke-WebRequest -Method Head http://localhost:3002).Headers['X-Served-By']
}
```

Esperado: sempre `app-02`. Prova que a alternância vem do balanceador,
não da aplicação.

### 7.7 Logs

Enquanto roda 7.3, o terminal do LB imprime uma linha por requisição:

```
[LB] GET / -> http://localhost:3001 (200)
[LB] GET / -> http://localhost:3002 (200)
[LB] GET / -> http://localhost:3003 (200)
```

Isso é a evidência de que o balanceador distribuiu as requisições, como o
enunciado pede no item 6 do roteiro de verificação.


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

- **Estado em memória não sobrevive à alternância.** Se a app guardasse
  sessão de usuário no processo, o usuário "perderia" o login a cada
  requisição que caísse em outra instância. Solução: *sticky sessions*
  (cookie ou IP) ou store externo (Redis, DB).
- **Round-robin ignora latência e carga.** Um backend lento recebe a mesma
  fatia. Alternativas: `least_conn`, weighted RR, ou algoritmos adaptativos.
- **Health check tem janela de até `HEALTH_CHECK_INTERVAL`.** Uma instância
  que morre logo após um check pode receber tráfego por até ~10 s antes de
  ser excluída — mitigado pelo fato de o próprio proxy marcar *unhealthy* ao
  detectar erro de conexão.
- **O balanceador é um SPOF** (*Single Point of Failure*). Se o `:8080`
  cair, o serviço cai. Em produção, rodariam pelo menos 2 Load Balancers
  atrás de um VIP/Anycast.
- **Sem TLS, sem HTTP/2, sem rate limiting.** Tudo isso existe em
  NGINX/HAProxy/Traefik e pode ser citado como evolução do projeto.
