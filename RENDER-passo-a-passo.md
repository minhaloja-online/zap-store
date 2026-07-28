# Publicar o servidor de pagamento no Render

Você não precisa instalar nada no computador. Tudo pelo navegador.

Antes de começar, tenha em mãos:
- o **Access Token de teste** do Mercado Pago (começa com `TEST-`)
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

---

## 4. As variáveis de ambiente

Ainda na mesma tela, em **Environment Variables**, adicione uma por uma:

| Key | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_PATH` | `/etc/secrets/firebase.json` |
| `MP_ACCESS_TOKEN` | seu token `TEST-...` |
| `NOME_NA_FATURA` | `ZAPSTORE` |
| `URL_SITE` | `https://minhaloja-online.github.io/teste-de-pagamento` |
| `ORIGENS_PERMITIDAS` | `https://minhaloja-online.github.io` |

Repare na diferença entre as duas últimas — ela derruba muita gente:

- **`URL_SITE`** é onde o cliente volta depois de pagar, então precisa do caminho completo até a pasta do site.
- **`ORIGENS_PERMITIDAS`** é só o domínio, sem caminho nenhum. É assim que o navegador se identifica.

Nenhuma das duas leva barra no final.

Falta a `URL_API`, que só existe depois que o serviço nascer. Agora sim: **Create Web Service**.

---

## 5. Fechar o ciclo

O Render vai instalar e subir. Leva uns 2 minutos. Quando terminar, no topo da página aparece o endereço, algo como:

```
https://servidor-pagamento.onrender.com
```

1. Copie esse endereço
2. Vá em **Environment** → adicione a última variável:

| Key | Value |
|---|---|
| `URL_API` | `https://servidor-pagamento.onrender.com` |

3. Salve. O Render reinicia sozinho.
4. Abra no navegador: `https://servidor-pagamento.onrender.com/api/status`

Tem que responder:

```json
{"ok":true,"ambiente":"teste"}
```

Se apareceu isso, o servidor está de pé e falando com o Firebase.

---

## 6. Cadastrar o webhook

Painel do Mercado Pago → sua aplicação → **Webhooks** → **Configurar notificações**

- URL: `https://servidor-pagamento.onrender.com/api/webhook`
- Evento: **Pagamentos**

Salve.

É aqui que o dinheiro é confirmado. A página de sucesso não prova nada — qualquer pessoa digita o endereço dela no navegador sem ter pago. Sem o webhook, o pedido pago fica preso em "aguardando pagamento" para sempre.

---

## 7. Ligar a loja

1. Suba as três páginas de retorno (`sucesso.html`, `pendente.html`, `falha.html`) também no **repositório do site**, na mesma pasta do `index.html`. Elas precisam estar nos dois lugares: o Render usa para o caso de alguém acessar por lá, e o GitHub Pages é para onde o cliente realmente volta.
2. Abra sua loja, entre como vendedor
3. **Configurações da Loja** → campo **Endereço do servidor de pagamento** → cole `https://servidor-pagamento.onrender.com`
4. Salvar

O botão **💳 Pagar agora** aparece no carrinho na hora.

---

## 8. A primeira compra de teste

Monte um carrinho e clique em **Pagar agora**. Cartão de teste:

| Bandeira | Número | CVV | Validade |
|---|---|---|---|
| Mastercard | 5031 4332 1540 6351 | 123 | 11/30 |
| Visa | 4235 6477 2802 5682 | 123 | 11/30 |

No **nome do titular**, o que você digita decide o resultado:

- `APRO` → aprovado
- `OTHE` → recusado
- `FUND` → saldo insuficiente

CPF: `12345678909`

Se pedir login, crie um **usuário de teste** em Suas integrações → Contas de teste. Não use sua conta real no ambiente de teste.

**Depois de pagar com `APRO`, confira no painel do vendedor:** o pedido tem que ter virado **📦 Pendente de envio** sozinho, com o estoque debitado. Se ficou em "aguardando pagamento", o webhook não chegou — veja os logs no Render.

Teste também com `OTHE`: o pedido tem que continuar em "aguardando pagamento", sem mexer no estoque.

---

## O que esperar do plano gratuito

O servidor **dorme** depois de uns 15 minutos sem uso. A primeira compra depois de um tempo parado demora uns 30 a 50 segundos para abrir o checkout — o cliente vê a aba em branco esperando.

Para testar tudo isso agora, não atrapalha. Para vender de verdade, o plano pago mais barato do Render resolve.

---

## Se travar

| Sintoma | Causa |
|---|---|
| `/api/status` não abre | Veja **Logs** no Render. Quase sempre é a chave do Firebase. |
| `Falta a chave do Firebase` nos logs | `FIREBASE_SERVICE_ACCOUNT_PATH` está errado. Tem que ser `/etc/secrets/` + o nome exato que você deu ao Secret File. |
| Erro de CORS no console do navegador | `ORIGENS_PERMITIDAS` está com caminho ou barra no fim. Só o domínio. |
| `auto_return invalid` | `URL_SITE` está errada ou com barra no fim. |
| Botão "Pagar agora" não aparece | O campo nas Configurações da Loja está vazio, ou você não salvou. |
| Pedido pago fica em "aguardando pagamento" | Webhook não cadastrado, ou `URL_API` errada. Confira os logs do Render na hora do pagamento. |
| Checkout demora 40s para abrir | Normal no plano free. O servidor estava dormindo. |
