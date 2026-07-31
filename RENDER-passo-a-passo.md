# Publicar o servidor de pagamento no Render (Asaas)

Você não precisa instalar nada no computador. Tudo pelo navegador.

Antes de começar, tenha em mãos:
- a **API Key de Sandbox** da Asaas (gerada em `sandbox.asaas.com` → Integrações → Chaves de API)
- o arquivo **`.json`** da conta de serviço do Firebase

---

## 1. Criar o repositório do servidor

O servidor precisa de um repositório **separado** do site. O do site está publicado no GitHub Pages; misturar os dois dá confusão.

1. No GitHub: **New repository**
2. Nome: `servidor-pagamento`
3. Marque **Private** — aqui vai código de cobrança, não precisa ser público
4. **Create repository**

Na tela seguinte, clique em **uploading an existing file** e arraste:

```
server.js
package.json
.gitignore
```

E dentro de uma pasta `public/`:

```
public/sucesso.html
public/pendente.html
public/falha.html
```

> Para criar a subpasta no upload do GitHub, arraste a pasta `public` inteira de uma vez, ou digite `public/sucesso.html` no campo de nome ao criar o arquivo.

**Não suba o `.env.example`, o `.env`, nem o `.json` do Firebase.** As chaves vão direto no Render, nunca em arquivo.

Clique em **Commit changes**.

> ⚠️ **O Render sempre constrói a partir do que está no GitHub.** Editar o arquivo só na sua máquina, ou clicar em "Manual Deploy" sem ter feito commit, não muda nada — ele vai buildar o código antigo de novo. Toda alteração no `server.js` precisa virar um commit no repositório.

---

## 2. Criar o serviço no Render

1. Entre em **render.com** e crie a conta (dá para entrar com o GitHub)
2. **New +** → **Web Service**
3. Conecte sua conta do GitHub e autorize o acesso ao repositório `servidor-pagamento`
4. Selecione o repositório

Preencha:

| Campo | Valor |
|---|---|
| Name | `servidor-pagamento` (vira parte do endereço) |
| Language / Runtime | **Node** |
| Branch | `main` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | **Free** |

Ainda **não** clique em criar. Falta a parte de baixo.

---

## 3. A chave do Firebase

Role até **Secret Files** (ou **Advanced → Add Secret File**).

- **Filename:** `firebase.json`
- **Contents:** abra o arquivo `.json` que você baixou do Firebase no Bloco de Notas, selecione tudo, copie e cole aqui **exatamente como está**. Não tire quebras de linha, não mexa em nada.

Esse é o jeito à prova de erro. O outro caminho, colar o JSON como texto numa variável, quebra com facilidade porque a chave privada tem quebras de linha dentro.

> O nome do arquivo aqui precisa bater **exatamente** com o que você vai colocar em `FIREBASE_SERVICE_ACCOUNT_PATH` no próximo passo. Se o Secret File se chama `firebase.json`, a variável tem que ser `/etc/secrets/firebase.json`. Errar isso derruba o servidor no start com `ENOENT: no such file or directory`.

---

## 4. As variáveis de ambiente

Ainda na mesma tela, em **Environment Variables**, adicione uma por uma:

| Key | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `/etc/secrets/firebase.json` |
| `ASAAS_API_KEY` | sua chave de Sandbox |
| `ASAAS_API_URL` | `https://api-sandbox.asaas.com/v3` |
| `URL_SITE` | `https://minhaloja-online.github.io/teste-de-pagamento` |
| `ORIGENS_PERMITIDAS` | `https://minhaloja-online.github.io` |

Repare na diferença entre as duas últimas — ela derruba muita gente:

- **`URL_SITE`** é onde o cliente volta depois de pagar, então precisa do caminho completo até a pasta do site.
- **`ORIGENS_PERMITIDAS`** é só o domínio, sem caminho nenhum. É assim que o navegador se identifica.

Nenhuma das duas leva barra no final.

Faltam a `URL_API` e o `ASAAS_WEBHOOK_TOKEN`, que só existem depois que o serviço nascer. Agora sim: **Create Web Service**.

> Se você está migrando do Mercado Pago, aproveite para **apagar** as variáveis `MP_ACCESS_TOKEN` e `NOME_NA_FATURA`. Elas não são mais lidas por nada.

---

## 5. Fechar o ciclo

O Render vai instalar e subir. Leva uns 2 minutos. Quando terminar, no topo da página aparece o endereço, algo como:

```
https://servidor-pagamento-asaas-zapstore.onrender.com
```

1. Copie esse endereço
2. Vá em **Environment** → adicione:

| Key | Value |
|---|---|
| `URL_API` | `https://servidor-pagamento-asaas-zapstore.onrender.com` |

3. Salve. O Render reinicia sozinho.
4. Abra no navegador: `https://servidor-pagamento-asaas-zapstore.onrender.com/api/status`

Tem que responder:

```json
{"ok":true,"ambiente":"sandbox"}
```

Se apareceu isso, o servidor está de pé e falando com o Firebase.

### Ler o log de inicialização

Na aba **Logs**, o start bem-sucedido é assim:

```
Firebase conectado ao projeto: zap-store-aefc1
Servidor rodando na porta 10000
```

Se aparecer algum aviso de `Falta ...`, tem variável faltando. E se aparecer **`Falta MP_ACCESS_TOKEN`**, o código que subiu ainda é o antigo, do Mercado Pago — volte ao passo 1 e confirme que o commit do `server.js` novo realmente foi feito.

---

## 6. Cadastrar o webhook

Painel da Asaas (Sandbox) → **Integrações → Webhooks → Adicionar Webhook**

| Campo | Valor |
|---|---|
| Este Webhook ficará ativo? | **ligado** |
| Nome do Webhook | `zap-store` |
| URL do Webhook | `https://servidor-pagamento-asaas-zapstore.onrender.com/api/webhook` |
| E-mail | o seu, para ser avisado se a fila cair |
| Versão da API | `v3` |
| Token de autenticação | clique em **Gerar Token** e **copie** |
| Tipo de envio | Sequencial |
| Fila de sincronização ativada? | **ligado** |

Em **Adicionar Eventos → Cobranças**, marque pelo menos:

- `PAYMENT_CONFIRMED`
- `PAYMENT_RECEIVED`

Clique em **Salvar**.

Agora volte ao Render, em **Environment**, e adicione a última variável:

| Key | Value |
|---|---|
| `ASAAS_WEBHOOK_TOKEN` | o token que você acabou de gerar |

Tem que ser **exatamente igual** ao que está no painel da Asaas. Se não bater, o servidor devolve 401 e todo pagamento fica preso — a Asaas até avisa, mas seu pedido nunca sai do rascunho.

> ⚠️ Confira que a URL termina mesmo em `/api/webhook`. Só o domínio não funciona.

É aqui que o dinheiro é confirmado. A página de sucesso não prova nada — qualquer pessoa digita o endereço dela no navegador sem ter pago. Sem o webhook, o pedido pago fica invisível para sempre.

---

## 7. Ligar a loja

1. Suba as três páginas de retorno (`sucesso.html`, `pendente.html`, `falha.html`) também no **repositório do site**, na mesma pasta do `index.html`.
2. Abra sua loja, entre como vendedor
3. **Configurações da Loja** → campo **Endereço do servidor de pagamento** → cole `https://servidor-pagamento-asaas-zapstore.onrender.com`
4. Salvar

O botão **💳 Pagar agora** aparece no carrinho na hora.

### Cadastre o domínio do site na Asaas

Em **Configurações da conta → Informações / Dados comerciais**, o site cadastrado precisa ser o mesmo do `URL_SITE`. Sem isso, a Asaas ignora o redirecionamento e o cliente não volta para a loja depois de pagar (o pagamento acontece normalmente, só a volta que não).

---

## 8. A primeira compra de teste

Monte um carrinho, **preencha o CPF** e clique em **Pagar agora**. Vai abrir a fatura da Asaas com Pix, boleto e cartão na mesma tela.

### Testando com cartão

| Resultado | Número | CCV | Validade |
|---|---|---|---|
| **Aprovado** | 4444 4444 4444 4444 | 123 | qualquer mês futuro |
| Recusado (Mastercard) | 5184 0197 4037 3151 | 123 | qualquer mês futuro |
| Recusado (Visa) | 4916 5613 5824 0741 | 123 | qualquer mês futuro |

### Testando com Pix ou boleto

No Sandbox eles não são pagos de verdade. Gere a cobrança, depois abra ela no painel do Sandbox em **Cobranças** e clique em **CONFIRMAR PAGAMENTO**. É esse botão que dispara o webhook.

### O que conferir

**Depois de pagar com o cartão aprovado**, o pedido tem que **aparecer** no painel do vendedor como **📦 Pendente de envio**, com o estoque debitado.

Lembre que, no caminho do pagamento online, o pedido nasce como rascunho invisível. Então:

- **Pagou** → o pedido aparece, já em "pendente de envio". ✅
- **Recusou ou desistiu** → o pedido **continua invisível**. Isso está certo, não é bug. ✅

Se você pagou e mesmo assim nada apareceu, o webhook não chegou. Onde olhar:

1. **Asaas → Integrações → Logs de Webhooks** — mostra se a Asaas tentou chamar e qual resposta recebeu.
2. **Render → Logs** — procure a linha `Webhook Asaas: pedido ... — cobrança ... — PAYMENT_CONFIRMED`.

Se a Asaas registrou **401**, o `ASAAS_WEBHOOK_TOKEN` do Render está diferente do token cadastrado no painel.

---

## O que esperar do plano gratuito

O servidor **dorme** depois de uns 15 minutos sem uso. A primeira compra depois de um tempo parado demora uns 30 a 50 segundos para abrir a fatura — o cliente vê a aba em branco esperando.

Isso também afeta o webhook: se a Asaas chamar com o servidor dormindo, a primeira tentativa pode dar timeout. Ela tenta de novo, mas se falhar muitas vezes a **fila de sincronização é pausada** e você precisa reativar no painel.

Para testar, não atrapalha. Para vender de verdade, o plano pago mais barato do Render resolve os dois problemas.

---

## Virar para produção

1. Na conta de **produção** (`asaas.com`), gere uma API Key nova.
2. Cadastre o webhook **de novo** lá — o de Sandbox não vale em produção. Gere um token novo.
3. No Render, troque as três variáveis:

| Key | Novo valor |
|---|---|
| `ASAAS_API_KEY` | a chave de produção |
| `ASAAS_API_URL` | `https://api.asaas.com/v3` |
| `ASAAS_WEBHOOK_TOKEN` | o token novo |

4. Confira em `/api/status` que aparece `"ambiente":"producao"`.
5. Faça uma compra real de R$ 1,00 e estorne depois.

---

## Se travar

| Sintoma | Causa |
|---|---|
| `ENOENT: /etc/secrets/firebase.json` | O Secret File não existe ou tem outro nome. Tem que ser `/etc/secrets/` + o nome exato que você deu. |
| `SyntaxError: "undefined" is not valid JSON` | Nenhuma das duas variáveis do Firebase chegou preenchida. |
| `Falta MP_ACCESS_TOKEN` nos logs | Subiu o `server.js` antigo. Confira o commit no GitHub. |
| `/api/status` não abre | Veja **Logs** no Render. Quase sempre é a chave do Firebase. |
| Erro 401 vindo da Asaas | Chave de um ambiente com a URL do outro. |
| Webhook com 401 nos logs da Asaas | `ASAAS_WEBHOOK_TOKEN` diferente do token do painel. |
| Erro de CORS no console do navegador | `ORIGENS_PERMITIDAS` está com caminho ou barra no fim. Só o domínio. |
| Cliente paga e não volta ao site | Domínio não cadastrado nos dados comerciais — ou foi boleto, que não redireciona. |
| Botão "Pagar agora" não aparece | O campo nas Configurações da Loja está vazio, ou você não salvou. |
| Pedido pago continua invisível | Webhook não chegou. Veja os Logs de Webhooks na Asaas e os Logs no Render. |
| Fatura demora 40s para abrir | Normal no plano free. O servidor estava dormindo. |
