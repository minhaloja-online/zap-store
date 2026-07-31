# Pagamento online na ZAP STORE com Asaas — passo a passo

Você já tem uma loja funcionando: catálogo no Firestore, carrinho, painel do vendedor com aprovação de pedidos, PDF e Excel. O que falta é receber o dinheiro dentro do site em vez de combinar por fora.

O botão de WhatsApp continua exatamente como está. O pagamento online entra ao lado dele, e o cliente escolhe.

---

## O que muda no fluxo dos pedidos

Hoje:

```
cliente monta o carrinho → WhatsApp → você aprova na mão → pendente de envio
```

Depois:

```
cliente monta o carrinho
   ├── WhatsApp .......... aguardando pagamento → você combina e aprova → pendente de envio
   └── Pagar agora ....... rascunho (invisível) → (dinheiro cai) → pendente de envio
```

No caminho do pagamento a aprovação manual desaparece: quem aprova é o dinheiro. O estoque é debitado sozinho no momento em que o pagamento é confirmado, com a mesma regra do botão "Aprovar" que você já usa.

### O pedido nasce invisível

Quando o cliente clica em **Pagar agora**, o pedido é gravado no Firestore com status `rascunho`. Nesse estado ele **não aparece** nem no painel do vendedor nem em "Meus Pedidos" do cliente.

Isso é de propósito: muita gente abre o pagamento e desiste no meio. Sem o rascunho, seu painel encheria de pedidos fantasma. O pedido só passa a existir de verdade quando o dinheiro cai — aí ele vira **📦 Pendente de envio** direto.

O caminho do WhatsApp é diferente: ali o pedido já nasce como **💳 Aguardando pagamento**, porque você vai combinar o pagamento por fora e precisa enxergar o pedido para isso.

---

## Por que precisa de um servidor

Seu site é um arquivo HTML só. Isso funciona bem para catálogo e carrinho, mas não serve para cobrar, por dois motivos:

1. **A chave de cobrança não pode ficar no HTML.** A API Key da Asaas autoriza cobranças na sua conta. Qualquer pessoa abre "ver código-fonte" e copia.

2. **Preço no navegador não vale nada.** Hoje o `total` do pedido é calculado no celular do cliente. Isso está ok porque você confere antes de aprovar. No pagamento automático não tem conferência humana — e alguém pode abrir o inspetor, trocar R$ 199,90 por R$ 0,01 e pagar.

O `server.js` deste pacote resolve os dois: guarda a chave e, antes de gerar a cobrança, **lê os preços de novo direto do seu Firestore**, ignorando o que veio do navegador. Se não bater, ele corrige.

---

## Antes de tudo: cheque as regras do Firestore

Isto é mais urgente que a Asaas.

Vá em **Firebase → Firestore Database → Regras**. Se estiver escrito algo como `allow read, write: if true;` ou tiver uma data de validade, seu banco está aberto: qualquer pessoa na internet pode mudar o preço dos seus produtos agora mesmo, sem hacker nenhum, só com o navegador.

Abra o arquivo **`firestore.rules`** deste pacote, cole o conteúdo lá e publique. Depois entre no site como cliente e confirme que o catálogo ainda carrega, e como vendedor que ainda consegue cadastrar produto.

Com preço aberto para edição, todo o resto perde o sentido.

---

## Etapa 1 — Conta e chave da Asaas

A Asaas tem dois ambientes completamente separados, com contas, chaves e URLs diferentes:

| Ambiente | Painel | URL da API |
|---|---|---|
| **Sandbox** (testes) | `sandbox.asaas.com` | `https://api-sandbox.asaas.com/v3` |
| **Produção** | `www.asaas.com` | `https://api.asaas.com/v3` |

Comece pelo Sandbox. A conta de Sandbox é criada na hora e normalmente já sai aprovada — não precisa esperar análise.

1. Crie a conta em **sandbox.asaas.com**.
2. No menu lateral: **Integrações → Chaves de API → Gerar chave**.
3. Dê um nome (ex.: `zap-store`) e copie a chave. **Ela só aparece uma vez.**

A chave de Sandbox só funciona na URL de Sandbox, e a de produção só na de produção. Misturar as duas é o erro mais comum, e o sintoma é sempre "chave inválida" ou erro 401.

Depois, em paralelo, comece a validar a conta de **produção** em `asaas.com` — a análise de documentos pode levar horas ou dias, então não deixe para o fim.

> A API Key vive **só no servidor**, nunca no HTML. Se ela vazar, qualquer pessoa emite cobranças e movimenta dinheiro na sua conta.

---

## Etapa 2 — CPF/CNPJ passou a ser obrigatório

Esta é a única mudança visível para o cliente.

A Asaas não emite cobrança sem um cliente cadastrado, e todo cliente precisa de CPF ou CNPJ. Por isso o carrinho ganhou um campo novo, com máscara automática e validação dos dígitos verificadores.

Como isso funciona nos dois caminhos:

- **Pagar agora**: o CPF/CNPJ é **obrigatório**. Sem ele o pedido nem chega a ser criado.
- **WhatsApp**: o campo é preenchido se o cliente quiser, mas não trava o envio — nesse caminho a Asaas não entra.

Do lado do servidor, antes de criar a cobrança o código procura na Asaas um cliente com aquele CPF/CNPJ. Se já existir, reaproveita; se não, cria. Assim o cliente que compra três vezes não vira três cadastros diferentes.

---

## Etapa 3 — Chave do Firebase para o servidor

O servidor precisa ler seu Firestore, e ele não faz login como pessoa — usa uma chave de máquina.

1. **Firebase → ⚙️ Configurações do projeto → Contas de serviço**
2. Clique em **Gerar nova chave privada**. Baixa um arquivo `.json`.
3. Guarde bem: essa chave dá acesso total ao seu banco. Não mande por WhatsApp, não suba no GitHub.

---

## Etapa 4 — Rodar na sua máquina

1. Instale o **Node.js 20 ou superior** em nodejs.org (versão LTS, next-next-finish). Confira no terminal:

```bash
node -v
```

2. Descompacte a pasta em algum lugar fácil, tipo `Documentos/loja-pagamento`.
3. Abra o terminal dentro dela. No Windows: entre na pasta pelo Explorer, clique na barra de endereço, digite `cmd` e Enter.

```bash
npm install
```

4. Copie `.env.example` para `.env` (tire o `.example` do nome).
5. Abra o `.env` no Bloco de Notas e preencha:
   - `ASAAS_API_KEY` = a chave de Sandbox que você copiou
   - `ASAAS_API_URL` = `https://api-sandbox.asaas.com/v3`
   - `FIREBASE_SERVICE_ACCOUNT` = **todo o conteúdo do arquivo .json em uma linha só**. Abra o `.json` no Bloco de Notas, tire as quebras de linha, cole tudo depois do `=`. Sem aspas em volta.
   - O resto pode ficar como está por enquanto.

6. Ligue:

```bash
npm start
```

Tem que aparecer `Firebase conectado ao projeto: ...` e `Servidor rodando na porta 3000`. Deixe a janela aberta — fechou, o servidor morre.

7. Teste no navegador: **http://localhost:3000/api/status**. Deve responder `{"ok":true,"ambiente":"sandbox"}`.

---

## Etapa 5 — Ligar o site ao servidor

O `index.html` novo já tem tudo. Você só precisa dizer onde o servidor está.

1. Publique o `index.html` novo no lugar do antigo.
2. Entre no site como vendedor.
3. Em **Configurações da Loja**, no campo **Endereço do servidor de pagamento**, coloque `http://localhost:3000` para testar.
4. Salve.

O botão **💳 Pagar agora** aparece no carrinho na hora. Se você apagar esse campo, o botão some e a loja volta a vender só pelo WhatsApp — é o seu interruptor.

---

## Etapa 6 — Testar sem gastar dinheiro

Monte um carrinho, preencha o CPF e clique em **Pagar agora**. Vai abrir a fatura da Asaas, com as três formas de pagamento na mesma tela: Pix, boleto e cartão. Quem escolhe é o cliente.

### Cartão de crédito

| Resultado | Número | CCV | Validade |
|---|---|---|---|
| **Aprovado** | 4444 4444 4444 4444 | 123 | qualquer mês futuro |
| Recusado (Mastercard) | 5184 0197 4037 3151 | 123 | qualquer mês futuro |
| Recusado (Visa) | 4916 5613 5824 0741 | 123 | qualquer mês futuro |

No Sandbox nenhuma adquirente é acionada de verdade: o resultado é decidido só pelo número do cartão.

### Pix e boleto

No Sandbox eles não são pagos de verdade. Depois de gerar a cobrança, abra ela no painel do Sandbox (**Cobranças**) e clique em **CONFIRMAR PAGAMENTO**. É esse botão que dispara o webhook, como se o dinheiro tivesse caído.

Não existe endpoint de API para confirmar pagamento no Sandbox — tem que ser pelo painel mesmo.

> Se o Pix der erro 404 no Sandbox, é porque a conta de teste está sem chave Pix cadastrada. Cadastre uma no painel do Sandbox.

### O que conferir depois de cada teste

Abra o painel do vendedor e olhe o pedido:

- **Cartão aprovado / Pix confirmado / boleto confirmado** → o pedido tem que **aparecer** como **📦 Pendente de envio**, com o estoque debitado.
- **Cartão recusado** → o pedido tem que continuar **invisível** (ainda é rascunho). Nada aparece no painel, e o estoque não se mexe. Isso está certo.

> Nesta etapa, rodando em `localhost`, o pedido **não vai** virar "pendente de envio" sozinho — falta o webhook, que é a Etapa 8. A Asaas não enxerga a sua máquina.

---

## Etapa 7 — Publicar o servidor

`localhost` só existe na sua máquina. Para o cliente pagar de casa e para a Asaas avisar quando o dinheiro cair, o servidor precisa estar na internet.

O passo a passo detalhado disso está no arquivo **`RENDER-passo-a-passo.md`**. Em resumo: sobe o código para um repositório no GitHub, conecta esse repositório no Render, e cadastra as variáveis de ambiente lá no painel — nunca em arquivo.

Variáveis que o servidor usa:

| Variável | Para que serve |
|---|---|
| `ASAAS_API_KEY` | a chave da Asaas |
| `ASAAS_API_URL` | qual ambiente usar (sandbox ou produção) |
| `ASAAS_WEBHOOK_TOKEN` | confirma que o webhook veio mesmo da Asaas |
| `ASAAS_DIAS_VENCIMENTO` | prazo do boleto/Pix (opcional, padrão 3 dias) |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | caminho do arquivo de chave do Firebase |
| `URL_API` | endereço do próprio servidor |
| `URL_SITE` | onde está o `index.html` |
| `ORIGENS_PERMITIDAS` | qual domínio pode chamar a API |

As variáveis `MP_ACCESS_TOKEN` e `NOME_NA_FATURA` eram do Mercado Pago e **não são mais usadas** — pode apagar.

---

## Etapa 8 — Webhook: onde o dinheiro é confirmado

A página `sucesso.html` **não prova pagamento nenhum**. Ela só diz que o navegador voltou. Qualquer pessoa digita `seusite.com/sucesso.html` na barra de endereço sem ter pago nada.

Quem confirma é o **webhook**: a Asaas chama seu servidor, já mandando os dados da cobrança, e o servidor confere se o valor bate com o pedido antes de debitar o estoque e mandar para "pendente de envio".

Para ligar, no painel da Asaas: **Integrações → Webhooks → Adicionar Webhook**

| Campo | Valor |
|---|---|
| Nome | `zap-store` |
| URL | `https://seu-servidor.onrender.com/api/webhook` |
| Versão da API | `v3` |
| Token de autenticação | clique em **Gerar Token** e guarde — vai virar o `ASAAS_WEBHOOK_TOKEN` |
| Este Webhook ficará ativo? | **sim** |
| Fila de sincronização ativada? | **sim** |

Em **Adicionar Eventos → Cobranças**, marque pelo menos:

- `PAYMENT_CONFIRMED` — pagamento feito (o saldo ainda não caiu na conta)
- `PAYMENT_RECEIVED` — saldo já disponível

O servidor trata os dois como "pago". Não faz sentido esperar o saldo cair para começar a separar o pedido.

Marcar eventos a mais não quebra nada: o servidor anota e ignora os que não interessam. Mas quanto menos eventos, mais rápido o envio.

Três coisas que o `server.js` já cuida e que você deve saber que existem:

- **Notificação repetida.** A Asaas garante entregar *pelo menos uma vez* — ou seja, pode chamar duas vezes o mesmo evento. Sem proteção, o estoque baixaria duas vezes. O código usa uma transação e verifica se aquele pagamento já foi processado.
- **Valor divergente.** Se o valor pago não bater com o total do pedido, o código não libera nada e grava um alerta. Você vê no painel.
- **Quem está chamando.** O token do webhook é conferido a cada chamada. Sem ele, qualquer pessoa que descobrisse a URL poderia fingir um pagamento.

> **Testar webhook na sua máquina:** a Asaas não enxerga `localhost`. Instale o `ngrok`, rode `ngrok http 3000` e use a URL `https://...ngrok-free.app` tanto no `.env` (`URL_API`) quanto no cadastro do webhook.

---

## Etapa 9 — Redirecionamento depois do pagamento

Quando o pagamento confirma na hora (cartão ou Pix), a Asaas devolve o cliente para o site em `?pagamento=sucesso`, e a loja mostra o aviso de pagamento aprovado.

Duas armadilhas:

1. **O domínio precisa estar cadastrado.** Em **Configurações da conta → Informações / Dados comerciais**, o site cadastrado tem que ser o mesmo do `URL_SITE`. Se não bater, a Asaas simplesmente ignora o redirecionamento e o cliente fica parado na fatura.

2. **Boleto não redireciona.** Boleto leva dias para compensar, então não existe "voltar ao site depois de pagar". O cliente fecha a aba e pronto — quando o dinheiro cair, o webhook resolve o resto sozinho.

Por causa disso, as páginas `falha.html` e `pendente.html` praticamente não são mais usadas: a Asaas só redireciona em caso de sucesso. Elas continuam no pacote, mas não se assuste se nunca abrirem.

---

## Etapa 10 — Virar a chave para produção

Só depois que tudo acima funcionou em Sandbox:

1. Na conta de **produção** (`asaas.com`), gere uma API Key nova em Integrações → Chaves de API.
2. Cadastre o webhook **de novo**, na conta de produção — webhook de Sandbox não vale em produção. Gere um token novo também.
3. No Render, troque:
   - `ASAAS_API_KEY` pela chave de produção
   - `ASAAS_API_URL` para `https://api.asaas.com/v3`
   - `ASAAS_WEBHOOK_TOKEN` pelo token novo
4. Reinicie o serviço. Confira em `/api/status` que aparece `"ambiente":"producao"`.
5. Cadastre um produto de R$ 1,00, escondido no catálogo, e **compre com seu próprio cartão, do celular, fora do wi-fi de casa**.
6. Confira: o dinheiro apareceu no painel da Asaas? O pedido virou "pendente de envio" sozinho? O estoque baixou?
7. Estorne o R$ 1,00 pelo painel e apague o produto de teste.

Nunca pule o passo 5. Teste aprovado no Sandbox não garante produção aprovada.

---

## Checklist final

- [ ] Regras do Firestore publicadas — catálogo não é mais editável por qualquer um
- [ ] API Key de produção só nas variáveis do Render
- [ ] `.env` e o `.json` do Firebase fora do GitHub
- [ ] Chave e URL da API são do mesmo ambiente (as duas de Sandbox, ou as duas de produção)
- [ ] Preços recalculados no servidor (já está no `server.js`)
- [ ] Campo de CPF/CNPJ aparecendo e validando no carrinho
- [ ] Site e servidor em HTTPS
- [ ] Webhook cadastrado, com token, e testado
- [ ] Domínio do site cadastrado nos dados comerciais da Asaas
- [ ] Notificação repetida não debita estoque duas vezes
- [ ] Compra real de R$ 1,00 feita e estornada
- [ ] Política de troca e reembolso publicada no site, com seu contato

---

## Quando travar

| Sintoma | Causa provável |
|---|---|
| `SyntaxError: "undefined" is not valid JSON` no start | A chave do Firebase não chegou. `FIREBASE_SERVICE_ACCOUNT_PATH` aponta para um arquivo que não existe, ou `FIREBASE_SERVICE_ACCOUNT` está vazio. |
| `ENOENT: no such file or directory, open '/etc/secrets/firebase.json'` | O Secret File com esse nome exato não foi criado no Render. |
| `Falta MP_ACCESS_TOKEN no .env` nos logs | O `server.js` que subiu ainda é a versão antiga, do Mercado Pago. O commit não foi feito ou não pegou. |
| Erro 401 na Asaas | Chave de um ambiente com URL do outro. Confira `ASAAS_API_KEY` e `ASAAS_API_URL`. |
| `CPF/CNPJ do cliente não informado` | Pedido antigo, criado antes do campo existir. Faça um pedido novo. |
| `Este pedido não está aguardando pagamento` | O pedido já foi pago, cancelado ou enviado. Só `rascunho` e `aguardando_pagamento` podem gerar cobrança. |
| Botão "Pagar agora" não aparece | O campo "Endereço do servidor de pagamento" está vazio nas configurações. |
| Erro de CORS no console | O endereço do site não está em `ORIGENS_PERMITIDAS`. Copie exatamente, com `https://` e sem barra final. |
| Cliente paga e não volta para o site | Domínio não cadastrado nos dados comerciais da Asaas — ou foi boleto, que não redireciona mesmo. |
| Pedido pago continua invisível | O webhook não chegou. Veja **Integrações → Logs de Webhooks** no painel da Asaas e os logs do Render. |
| Pix dá erro 404 no Sandbox | A conta de teste está sem chave Pix cadastrada. |

Documentação oficial: **docs.asaas.com**
