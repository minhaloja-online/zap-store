# Pagamento online na ZAP STORE — passo a passo

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
   ├── WhatsApp .......... pendente de aprovação → você aprova → pendente de envio
   └── Pagar agora ....... aguardando pagamento → (dinheiro cai) → pendente de envio
```

No caminho do pagamento a aprovação manual desaparece: quem aprova é o dinheiro. O estoque é debitado sozinho no momento em que o pagamento é confirmado, com a mesma regra do botão "Aprovar" que você já usa.

Um status novo aparece no painel: **💳 Aguardando pagamento**. São pedidos que abriram o checkout e ainda não pagaram. Muitos vão ficar parados aí — é normal, gente desiste no meio. Você cancela quando quiser.

---

## Por que precisa de um servidor

Seu site é um arquivo HTML só. Isso funciona bem para catálogo e carrinho, mas não serve para cobrar, por dois motivos:

1. **A chave de cobrança não pode ficar no HTML.** O `Access Token` do Mercado Pago autoriza cobranças na sua conta. Qualquer pessoa abre "ver código-fonte" e copia.

2. **Preço no navegador não vale nada.** Hoje o `total` do pedido é calculado no celular do cliente. Isso está ok porque você confere antes de aprovar. No pagamento automático não tem conferência humana — e alguém pode abrir o inspetor, trocar R$ 199,90 por R$ 0,01 e pagar.

O `server.js` deste pacote resolve os dois: guarda a chave e, antes de gerar a cobrança, **lê os preços de novo direto do seu Firestore**, ignorando o que veio do navegador. Se não bater, ele corrige.

---

## Antes de tudo: cheque as regras do Firestore

Isto é mais urgente que o Mercado Pago.

Vá em **Firebase → Firestore Database → Regras**. Se estiver escrito algo como `allow read, write: if true;` ou tiver uma data de validade, seu banco está aberto: qualquer pessoa na internet pode mudar o preço dos seus produtos agora mesmo, sem hacker nenhum, só com o navegador.

Abra o arquivo **`firestore.rules`** deste pacote, cole o conteúdo lá e publique. Depois entre no site como cliente e confirme que o catálogo ainda carrega, e como vendedor que ainda consegue cadastrar produto.

Com preço aberto para edição, todo o resto perde o sentido.

---

## Etapa 1 — Conta e credenciais do Mercado Pago

1. Entre em **mercadopago.com.br** e valide a conta com CPF ou CNPJ. Pode levar horas ou dias, então comece hoje.
2. Vá em **mercadopago.com.br/developers** → **Suas integrações** → **Criar aplicação**.
3. Nome à vontade, tipo **Pagamentos online**, produto **Checkout Pro**.
4. No menu lateral: **Credenciais de teste** e **Credenciais de produção**.

| Chave | Onde vive | Pode aparecer no navegador? |
|---|---|---|
| Public Key | frontend | Sim |
| **Access Token** | **só no servidor** | **Nunca** |

Teste começa com `TEST-`, produção com `APP_USR-`.

**Copie agora o Access Token de teste.**

---

## Etapa 2 — Chave do Firebase para o servidor

O servidor precisa ler seu Firestore, e ele não faz login como pessoa — usa uma chave de máquina.

1. **Firebase → ⚙️ Configurações do projeto → Contas de serviço**
2. Clique em **Gerar nova chave privada**. Baixa um arquivo `.json`.
3. Guarde bem: essa chave dá acesso total ao seu banco. Não mande por WhatsApp, não suba no GitHub.

---

## Etapa 3 — Rodar na sua máquina

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
   - `MP_ACCESS_TOKEN` = o token de teste
   - `FIREBASE_SERVICE_ACCOUNT` = **todo o conteúdo do arquivo .json em uma linha só**. Abra o `.json` no Bloco de Notas, tire as quebras de linha, cole tudo depois do `=`. Sem aspas em volta.
   - O resto pode ficar como está por enquanto.

6. Ligue:

```bash
npm start
```

Tem que aparecer `Servidor rodando na porta 3000`. Deixe a janela aberta — fechou, o servidor morre.

7. Teste no navegador: **http://localhost:3000/api/status**. Deve responder `{"ok":true,"ambiente":"teste"}`.

---

## Etapa 4 — Ligar o site ao servidor

O `index.html` novo já tem tudo. Você só precisa dizer onde o servidor está.

1. Publique o `index.html` novo no lugar do antigo.
2. Entre no site como vendedor.
3. Em **Configurações da Loja** apareceu um campo novo: **Endereço do servidor de pagamento**. Coloque `http://localhost:3000` para testar.
4. Salve.

O botão **💳 Pagar agora** aparece no carrinho na hora. Se você apagar esse campo, o botão some e a loja volta a vender só pelo WhatsApp — é o seu interruptor.

Copie também as três páginas de retorno (`sucesso.html`, `pendente.html`, `falha.html`) para a mesma pasta do `index.html` no seu servidor de hospedagem.

---

## Etapa 5 — Testar sem gastar dinheiro

Monte um carrinho no site e clique em **Pagar agora**. Vai abrir o Mercado Pago. Use um cartão de teste:

| Bandeira | Número | CVV | Validade |
|---|---|---|---|
| Mastercard | 5031 4332 1540 6351 | 123 | 11/30 |
| Visa | 4235 6477 2802 5682 | 123 | 11/30 |

No campo **nome do titular**, o que você digita decide o resultado:

- `APRO` → aprovado
- `OTHE` → recusado
- `FUND` → saldo insuficiente
- `CALL` → precisa autorizar com o banco

CPF do titular: `12345678909`.

Teste os quatro. Depois de cada um, abra o painel do vendedor e olhe o pedido: com `APRO` ele deve ir para **pendente de envio** com o estoque debitado; com os outros deve continuar em **aguardando pagamento**.

Se pedir login na hora de pagar, crie um **usuário de teste** em Suas integrações → Contas de teste. Não use sua conta real no ambiente de teste.

> Nesta etapa o estoque **ainda não vai baixar sozinho** — falta o webhook, que é a Etapa 7. Por enquanto confira só se o pedido aparece com o status certo.

---

## Etapa 6 — Publicar o servidor

`localhost` só existe na sua máquina. Para o cliente pagar de casa e para o Mercado Pago avisar quando o dinheiro cair, o servidor precisa estar na internet.

Opções que rodam Node bem: **Render**, **Railway**, **Fly.io**. Todas com plano inicial gratuito ou de poucos dólares.

Roteiro:

1. Suba a pasta para um repositório no GitHub. O `.gitignore` já bloqueia o `.env` — **confira com os próprios olhos que ele não subiu**.
2. Na hospedagem, conecte o repositório. Comando de start: `npm start`.
3. Cadastre as variáveis **no painel da hospedagem**, não em arquivo:
   - `MP_ACCESS_TOKEN`
   - `FIREBASE_SERVICE_ACCOUNT`
   - `URL_API` = endereço que a hospedagem te deu (ex.: `https://zapstore.onrender.com`)
   - `URL_SITE` = onde está o `index.html` (ex.: `https://zapstore.com.br`)
   - `ORIGENS_PERMITIDAS` = o mesmo endereço do site
   - `NOME_NA_FATURA` = o que o cliente vê na fatura do cartão
4. No painel do vendedor, troque o **Endereço do servidor de pagamento** de `localhost` para o endereço novo.

> No plano gratuito do Render o servidor "dorme" quando fica sem uso. A primeira compra depois de um tempo parado pode demorar uns 30 segundos para abrir o checkout. Se isso incomodar, o plano pago mais barato resolve.

---

## Etapa 7 — Webhook: onde o dinheiro é confirmado

A página `sucesso.html` **não prova pagamento nenhum**. Ela só diz que o navegador voltou. Qualquer pessoa digita `seusite.com/sucesso.html` na barra de endereço sem ter pago nada.

Quem confirma é o **webhook**: o Mercado Pago avisa seu servidor, seu servidor pergunta à API dele qual é o status real, confere se o valor pago bate com o pedido, e só então debita o estoque e manda para "pendente de envio".

Para ligar: painel do Mercado Pago → sua aplicação → **Webhooks** → URL `https://seu-servidor.onrender.com/api/webhook`, evento **Pagamentos**.

Três coisas que o `server.js` já cuida e que você deve saber que existem:

- **Notificação repetida.** O Mercado Pago pode avisar duas vezes sobre o mesmo pagamento. Sem proteção, o estoque baixaria duas vezes. O código usa uma transação e verifica se aquele pagamento já foi processado.
- **Valor divergente.** Se o valor pago não bater com o total do pedido, o código não libera nada e grava um alerta. Você vê no painel.
- **Testar na sua máquina.** O Mercado Pago não enxerga `localhost`. Instale o `ngrok`, rode `ngrok http 3000` e use a URL `https://...ngrok-free.app` tanto no `.env` (`URL_API`) quanto no cadastro do webhook.

---

## Etapa 8 — Virar a chave para produção

Só depois que tudo acima funcionou em teste:

1. Troque `MP_ACCESS_TOKEN` pelo de **produção** (`APP_USR-`) no painel da hospedagem.
2. Reinicie o serviço. Confira em `/api/status` que aparece `"ambiente":"producao"`.
3. Cadastre um produto de R$ 1,00, escondido no catálogo, e **compre com seu próprio cartão, do celular, fora do wi-fi de casa**.
4. Confira: o dinheiro apareceu no painel do Mercado Pago? O pedido virou "pendente de envio" sozinho? O estoque baixou?
5. Estorne o R$ 1,00 pelo painel e apague o produto de teste.

Nunca pule o passo 3. Teste aprovado não garante produção aprovada.

---

## Checklist final

- [ ] Regras do Firestore publicadas — catálogo não é mais editável por qualquer um
- [ ] Access Token de produção só nas variáveis da hospedagem
- [ ] `.env` e o `.json` do Firebase fora do GitHub
- [ ] Preços recalculados no servidor (já está no `server.js`)
- [ ] Site e servidor em HTTPS
- [ ] Webhook cadastrado e testado
- [ ] Notificação repetida não debita estoque duas vezes
- [ ] Compra real de R$ 1,00 feita e estornada
- [ ] Política de troca e reembolso publicada no site, com seu contato

---

## Quando travar

| Sintoma | Causa provável |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` dá erro de JSON | O conteúdo do `.json` ficou com quebras de linha. Precisa ser uma linha só. |
| `auto_return invalid` | `URL_SITE` está errada. Precisa ser endereço público com `https://`, sem barra no fim. Não funciona com `localhost`. |
| Botão "Pagar agora" não aparece | O campo "Endereço do servidor de pagamento" está vazio nas configurações. |
| Erro de CORS no console | O endereço do site não está em `ORIGENS_PERMITIDAS`. Copie exatamente, com `https://` e sem barra final. |
| Webhook nunca chega | O Mercado Pago não enxerga `localhost`. Use ngrok ou teste já hospedado. |
| `invalid access token` | Misturou credencial de teste com ambiente de produção, ou o contrário. |
| Pedido pago continua "aguardando pagamento" | Webhook não está cadastrado, ou `URL_API` aponta para o lugar errado. Olhe os logs da hospedagem. |

Documentação oficial: **mercadopago.com.br/developers/pt/docs/checkout-pro/landing**
