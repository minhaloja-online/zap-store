import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

/* ==================== FIREBASE ==================== */
/*
 * A chave da conta de serviço pode chegar de dois jeitos:
 *  1) FIREBASE_SERVICE_ACCOUNT_PATH — caminho de um arquivo (Secret File no Render)
 *  2) FIREBASE_SERVICE_ACCOUNT      — o JSON colado como texto
 * O caminho 1 é o mais seguro contra erro de digitação. Se os dois existirem,
 * o arquivo ganha.
 */
function lerChaveFirebase() {
  const caminho = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (caminho) {
    return JSON.parse(readFileSync(caminho, 'utf8'));
  }

  const texto = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!texto) {
    throw new Error(
      'Falta a chave do Firebase. Defina FIREBASE_SERVICE_ACCOUNT_PATH (arquivo) ou FIREBASE_SERVICE_ACCOUNT (texto).'
    );
  }

  const chave = JSON.parse(texto);
  // Se o JSON passou por um campo que converteu "\n" em texto literal,
  // a chave privada quebra. Isto conserta o caso mais comum.
  if (chave.private_key && chave.private_key.includes('\\n')) {
    chave.private_key = chave.private_key.replace(/\\n/g, '\n');
  }
  return chave;
}

const chaveFirebase = lerChaveFirebase();

admin.initializeApp({
  credential: admin.credential.cert(chaveFirebase),
});
const db = admin.firestore();

console.log(`Firebase conectado ao projeto: ${chaveFirebase.project_id}`);

/* ==================== ASAAS ====================
 * Documentação: https://docs.asaas.com
 * ASAAS_API_URL:
 *   Sandbox (testes):   https://api-sandbox.asaas.com/v3
 *   Produção:           https://api.asaas.com/v3
 */
const ASAAS_API_URL = (process.env.ASAAS_API_URL || 'https://api.asaas.com/v3').replace(/\/+$/, '');
const ASAAS_API_KEY = (process.env.ASAAS_API_KEY || '').trim();
// Token que você mesmo define e cadastra no painel da Asaas (Integrações > Webhooks
// > Token de autenticação). Usado para confirmar que a chamada em /api/webhook
// realmente veio da Asaas, e não de qualquer pessoa que descubra a URL.
const ASAAS_WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || '';
// Quantos dias o cliente tem para pagar o boleto/Pix antes da cobrança vencer.
const DIAS_PARA_VENCER = Number(process.env.ASAAS_DIAS_VENCIMENTO || 3);

// Wrapper simples para chamar a API da Asaas com a autenticação já configurada.
async function asaas(caminho, opcoes = {}) {
  const resposta = await fetch(ASAAS_API_URL + caminho, {
    ...opcoes,
    headers: {
      'Content-Type': 'application/json',
      'access_token': ASAAS_API_KEY,
      ...(opcoes.headers || {}),
    },
  });
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const msg = corpo?.errors?.[0]?.description || `Asaas respondeu ${resposta.status}`;
    throw new Error(msg);
  }
  return corpo;
}

// Evita criar um cliente duplicado na Asaas a cada pedido: busca pelo CPF/CNPJ
// e só cria um novo se ainda não existir nenhum com esse documento.
async function encontrarOuCriarCliente(cliente) {
  const cpfCnpj = String(cliente?.cpfCnpj || '').replace(/\D/g, '');
  if (!cpfCnpj) throw new Error('CPF/CNPJ do cliente não informado.');

  const lista = await asaas(`/customers?cpfCnpj=${cpfCnpj}`);
  if (Array.isArray(lista?.data) && lista.data.length) return lista.data[0].id;

  const fone = String(cliente?.fone || '').replace(/\D/g, '');
  const novo = await asaas('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: String(cliente?.nome || 'Cliente').slice(0, 100),
      cpfCnpj,
      mobilePhone: fone || undefined,
    }),
  });
  return novo.id;
}

const URL_API = (process.env.URL_API || '').replace(/\/+$/, '');
const URL_SITE = (process.env.URL_SITE || '').replace(/\/+$/, '');

/* ==================== APP ==================== */
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Só o seu site pode chamar esta API.
const ORIGENS = (process.env.ORIGENS_PERMITIDAS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origem, cb) => {
    if (!origem || ORIGENS.length === 0 || ORIGENS.includes(origem)) return cb(null, true);
    cb(new Error('Origem não autorizada'));
  },
}));

/* ==================== REGRAS DE PREÇO ==================== */
// Precisam ser iguais às do site.
const QTD_ATACADO = 3;

// Preço pode ter sido gravado como texto ("49,90") por importação de planilha.
function paraNumero(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  return Number(v.trim().replace(/\s|R\$/gi, '').replace(/\./g, '').replace(',', '.'));
}

const temAtacado = p =>
  p.precoAtacado !== undefined &&
  p.precoAtacado !== null &&
  paraNumero(p.precoAtacado) > 0 &&
  paraNumero(p.precoAtacado) < paraNumero(p.preco);

const precoUnit = (p, qtd) =>
  (temAtacado(p) && qtd >= QTD_ATACADO) ? paraNumero(p.precoAtacado) : paraNumero(p.preco);

/* ==================== CRIAR PAGAMENTO ==================== */
/*
 * O navegador manda só o ID do pedido. Os preços são lidos de novo aqui,
 * direto da coleção "produtos". Assim, mesmo que alguém adultere o preço no
 * navegador antes de enviar, quem manda é o valor que está no banco.
 *
 * A cobrança é criada com billingType "UNDEFINED": isso faz a Asaas mostrar,
 * na própria fatura, os três meios de pagamento (Pix, boleto e cartão) e
 * deixa o cliente escolher ali qual prefere usar.
 */
app.post('/api/criar-preferencia', async (req, res) => {
  try {
    const { pedidoId } = req.body;
    if (!pedidoId || typeof pedidoId !== 'string') {
      return res.status(400).json({ erro: 'Pedido não informado.' });
    }

    const refPedido = db.collection('pedidos').doc(pedidoId);
    const snap = await refPedido.get();
    if (!snap.exists) return res.status(404).json({ erro: 'Pedido não encontrado.' });

    const pedido = snap.data();

    // Aceita dois casos: "rascunho" (primeira tentativa de pagamento, pedido ainda
    // invisível) e "aguardando_pagamento" (retentativa de um pedido já visível,
    // ex: boleto/Pix gerado antes que não foi pago, ou reenvio pelo WhatsApp).
    // Qualquer outro status (pago, cancelado, enviado etc.) não pode gerar cobrança nova.
    if (pedido.status !== 'aguardando_pagamento' && pedido.status !== 'rascunho') {
      return res.status(409).json({ erro: 'Este pedido não está aguardando pagamento.' });
    }
    if (!Array.isArray(pedido.itens) || pedido.itens.length === 0) {
      return res.status(400).json({ erro: 'Pedido sem itens.' });
    }
    if (!pedido.cliente?.cpfCnpj) {
      return res.status(400).json({ erro: 'CPF/CNPJ do cliente não informado.' });
    }

    // Reconfere cada item contra o catálogo
    const itens = [];
    let total = 0;

    for (const item of pedido.itens) {
      const qtd = Number.parseInt(item.qtd, 10);
      if (!Number.isInteger(qtd) || qtd < 1 || qtd > 999) {
        return res.status(400).json({ erro: `Quantidade inválida em "${item.nome}".` });
      }

      const prodSnap = await db.collection('produtos').doc(String(item.id)).get();
      if (!prodSnap.exists) {
        console.warn(`Produto não encontrado no Firestore: id="${item.id}" nome="${item.nome}"`);
        return res.status(400).json({ erro: `Produto "${item.nome}" não existe mais.` });
      }

      const prod = prodSnap.data();
      const preco = Number(precoUnit(prod, qtd));
      if (!Number.isFinite(preco) || preco <= 0) {
        console.warn(`Preço inválido em "${prod.nome}": preco=${JSON.stringify(prod.preco)} precoAtacado=${JSON.stringify(prod.precoAtacado)}`);
        return res.status(400).json({ erro: `Preço inválido em "${prod.nome}".` });
      }

      total += preco * qtd;
      itens.push({
        id: String(item.id),
        title: String(prod.nome || item.nome).slice(0, 250),
        quantity: qtd,
        unit_price: Math.round(preco * 100) / 100,
      });
    }

    total = Math.round(total * 100) / 100;

    // Se o total do banco não bater com o recalculado, grava o correto e segue
    if (Math.abs(total - Number(pedido.total || 0)) > 0.01) {
      console.warn(`Total divergente no pedido ${pedido.codigo}: gravado ${pedido.total}, correto ${total}`);
      await refPedido.update({ total, itens: itens.map(i => ({ id: i.id, nome: i.title, preco: i.unit_price, qtd: i.quantity })) });
    }

    // Se já existe uma cobrança em aberto para este pedido, reaproveita o
    // mesmo link em vez de gerar outra cobrança na Asaas a cada tentativa.
    if (pedido.asaasPaymentId) {
      try {
        const existente = await asaas(`/payments/${pedido.asaasPaymentId}`);
        if (existente.status === 'PENDING' || existente.status === 'AWAITING_RISK_ANALYSIS') {
          return res.json({ linkPagamento: existente.invoiceUrl });
        }
      } catch (_) {
        // cobrança não encontrada/inválida: segue e cria uma nova
      }
    }

    const customerId = await encontrarOuCriarCliente(pedido.cliente);

    const descricao = itens.map(i => `${i.quantity}x ${i.title}`).join(', ').slice(0, 500) || `Pedido ${pedido.codigo}`;

    const vencimento = new Date(Date.now() + DIAS_PARA_VENCER * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    const cobranca = await asaas('/payments', {
      method: 'POST',
      body: JSON.stringify({
        customer: customerId,
        billingType: 'UNDEFINED', // deixa o cliente escolher Pix, boleto ou cartão na fatura
        value: total,
        dueDate: vencimento,
        description: descricao,
        externalReference: pedidoId,
        callback: {
          // Só é usado quando o pagamento confirma na hora (cartão/Pix). O
          // domínio precisa ser o mesmo cadastrado nos dados comerciais da
          // conta Asaas, senão a Asaas ignora o redirecionamento.
          successUrl: `${URL_SITE}/?pagamento=sucesso`,
          autoRedirect: true,
        },
      }),
    });

    await refPedido.update({
      asaasPaymentId: cobranca.id,
      asaasCustomerId: customerId,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Cobrança criada — pedido ${pedido.codigo} — R$ ${total}`);
    res.json({ linkPagamento: cobranca.invoiceUrl });
  } catch (erro) {
    console.error('Falha ao criar cobrança:', erro);
    res.status(500).json({ erro: erro.message || 'Não foi possível iniciar o pagamento.' });
  }
});

/* ==================== WEBHOOK ==================== */
/*
 * É AQUI que o pagamento é confirmado. A página de sucesso não prova nada:
 * qualquer pessoa pode digitar o endereço dela no navegador sem ter pago.
 *
 * A Asaas avisa por evento (PAYMENT_CONFIRMED, PAYMENT_RECEIVED, etc.) e já
 * manda os dados da cobrança no corpo da chamada — não é preciso perguntar
 * de novo à API deles.
 */
app.post('/api/webhook', async (req, res) => {
  // Confere o token configurado no painel da Asaas (Integrações > Webhooks),
  // pra ter certeza que quem está chamando essa URL é a própria Asaas.
  if (ASAAS_WEBHOOK_TOKEN && req.get('asaas-access-token') !== ASAAS_WEBHOOK_TOKEN) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // responde rápido, senão a Asaas tenta de novo

  try {
    const evento = req.body?.event;
    const payment = req.body?.payment;
    if (!payment) return;

    const pedidoId = payment.externalReference;
    const status = payment.status; // PENDING, CONFIRMED, RECEIVED, OVERDUE, REFUNDED...
    if (!pedidoId) return;

    console.log(`Webhook Asaas: pedido ${pedidoId} — cobrança ${payment.id} — ${evento} (${status})`);

    // "Confirmada" (pagamento feito, saldo ainda não caiu) ou "Recebida"
    // (saldo já disponível) contam como pagas — não faz sentido esperar até
    // o saldo cair pra liberar o pedido pra separação.
    const pago = status === 'CONFIRMED' || status === 'RECEIVED';

    if (!pago) {
      // pendente, vencida, estornada etc.: só anota, não mexe no estoque nem no status
      await db.collection('pedidos').doc(pedidoId).update({
        pagamento: {
          id: String(payment.id),
          status,
          metodo: payment.billingType || '',
          valor: payment.value || 0,
        },
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }

    const refPedido = db.collection('pedidos').doc(pedidoId);

    // Transação: garante que o estoque só é debitado uma vez, mesmo se a
    // Asaas chamar este endereço mais de uma vez para o mesmo pagamento
    // (o modelo de entrega dela é "at least once").
    await db.runTransaction(async tx => {
      // Numa transação do Firestore todas as leituras vêm antes das escritas.
      const snap = await tx.get(refPedido);
      if (!snap.exists) return;

      const pedido = snap.data();

      // Já foi processado antes? Então não debita de novo.
      if (pedido.pagamento?.status === 'CONFIRMED' || pedido.pagamento?.status === 'RECEIVED') return;

      const refsProdutos = (pedido.itens || []).map(i => db.collection('produtos').doc(String(i.id)));
      const snapsProdutos = refsProdutos.length ? await tx.getAll(...refsProdutos) : [];

      const infoPagamento = {
        id: String(payment.id),
        status,
        metodo: payment.billingType || '',
        valor: payment.value || 0,
      };

      // Confere se o valor pago bate com o pedido
      const esperado = Number(pedido.total || 0);
      const pagoValor = Number(payment.value || 0);
      if (Math.abs(esperado - pagoValor) > 0.01) {
        console.error(`VALOR DIVERGENTE no pedido ${pedido.codigo}: esperado ${esperado}, pago ${pagoValor}`);
        tx.update(refPedido, {
          pagamento: { ...infoPagamento, alerta: 'valor divergente' },
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      // Pagou: dá baixa no estoque e joga o pedido na fila de envio
      (pedido.itens || []).forEach((item, i) => {
        const prodSnap = snapsProdutos[i];
        if (!prodSnap || !prodSnap.exists) return; // produto excluído: ignora
        const atual = Number(prodSnap.data().estoque || 0);
        tx.update(refsProdutos[i], { estoque: Math.max(atual - Number(item.qtd || 0), 0) });
      });

      tx.update(refPedido, {
        status: 'pendente_envio',
        pagamento: infoPagamento,
        pagoEm: admin.firestore.FieldValue.serverTimestamp(),
        aprovadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (erro) {
    console.error('Erro no webhook:', erro);
  }
});

/* ==================== SAÚDE ==================== */
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    ambiente: ASAAS_API_URL.includes('sandbox') ? 'sandbox' : 'producao',
  });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor rodando na porta ${PORTA}`);
  console.log(`Asaas: usando ${ASAAS_API_URL}`);
  if (!process.env.ASAAS_API_URL) {
    console.warn('ASAAS_API_URL não definida — assumindo PRODUÇÃO. Se a sua chave é de Sandbox, defina https://api-sandbox.asaas.com/v3');
  }
  if (!process.env.ASAAS_API_KEY) console.warn('Falta ASAAS_API_KEY no .env');
  else if (process.env.ASAAS_API_KEY !== ASAAS_API_KEY) console.warn('ASAAS_API_KEY tinha espaço ou quebra de linha nas pontas — foi removido automaticamente, mas confira o valor no painel');
  if (!process.env.ASAAS_WEBHOOK_TOKEN) console.warn('Falta ASAAS_WEBHOOK_TOKEN no .env (webhook ficará sem verificação de origem)');
  if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.FIREBASE_SERVICE_ACCOUNT_PATH) console.warn('Falta a chave do Firebase');
});
