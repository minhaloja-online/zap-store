import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';

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

/* ==================== MERCADO PAGO ==================== */
const mp = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 10000 },
});

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
        currency_id: 'BRL',
      });
    }

    total = Math.round(total * 100) / 100;

    // Se o total do banco não bater com o recalculado, grava o correto e segue
    if (Math.abs(total - Number(pedido.total || 0)) > 0.01) {
      console.warn(`Total divergente no pedido ${pedido.codigo}: gravado ${pedido.total}, correto ${total}`);
      await refPedido.update({ total, itens: itens.map(i => ({ id: i.id, nome: i.title, preco: i.unit_price, qtd: i.quantity })) });
    }

    const preference = new Preference(mp);
    const resultado = await preference.create({
      body: {
        items: itens,
        external_reference: pedidoId,
        payer: {
          name: String(pedido.cliente?.nome || '').slice(0, 100),
        },
        back_urls: {
          success: `${URL_SITE}/sucesso.html`,
          failure: `${URL_SITE}/falha.html`,
          pending: `${URL_SITE}/pendente.html`,
        },
        auto_return: 'approved',
        notification_url: `${URL_API}/api/webhook`,
        statement_descriptor: (process.env.NOME_NA_FATURA || 'ZAPSTORE').slice(0, 22),
      },
    });

    await refPedido.update({
      preferenciaId: resultado.id,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Pagamento iniciado — pedido ${pedido.codigo} — R$ ${total}`);
    res.json({ linkPagamento: resultado.init_point });
  } catch (erro) {
    console.error('Falha ao criar preferência:', erro);
    res.status(500).json({ erro: 'Não foi possível iniciar o pagamento.' });
  }
});

/* ==================== WEBHOOK ==================== */
/*
 * É AQUI que o pagamento é confirmado. A página de sucesso não prova nada:
 * qualquer pessoa pode digitar o endereço dela no navegador sem ter pago.
 *
 * O Mercado Pago avisa que algo mudou; nós perguntamos à API dele qual é o
 * status real e só então mexemos no pedido.
 */
app.post('/api/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido, senão o Mercado Pago repete a chamada

  try {
    const tipo = req.query.type || req.body?.type;
    const pagamentoId = req.query['data.id'] || req.body?.data?.id;
    if (tipo !== 'payment' || !pagamentoId) return;

    const dados = await new Payment(mp).get({ id: pagamentoId });

    const pedidoId = dados.external_reference;
    const status = dados.status;
    if (!pedidoId) return;

    console.log(`Webhook: pedido ${pedidoId} — pagamento ${pagamentoId} — ${status}`);

    const refPedido = db.collection('pedidos').doc(pedidoId);

    // Transação: garante que o estoque só é debitado uma vez, mesmo se o
    // Mercado Pago chamar este endereço duas vezes para o mesmo pagamento.
    await db.runTransaction(async tx => {
      // Numa transação do Firestore todas as leituras vêm antes das escritas.
      const snap = await tx.get(refPedido);
      if (!snap.exists) return;

      const pedido = snap.data();

      const refsProdutos = (pedido.itens || []).map(i => db.collection('produtos').doc(String(i.id)));
      const snapsProdutos = refsProdutos.length ? await tx.getAll(...refsProdutos) : [];

      const infoPagamento = {
        id: String(pagamentoId),
        status,
        metodo: dados.payment_method_id || '',
        valor: dados.transaction_amount || 0,
      };

      if (status !== 'approved') {
        // rejeitado, cancelado, em análise: só anota, não mexe no estoque
        tx.update(refPedido, {
          pagamento: infoPagamento,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      // Já foi processado antes? Então não debita de novo.
      if (pedido.pagamento?.status === 'approved') return;

      // Confere se o valor pago bate com o pedido
      const esperado = Number(pedido.total || 0);
      const pago = Number(dados.transaction_amount || 0);
      if (Math.abs(esperado - pago) > 0.01) {
        console.error(`VALOR DIVERGENTE no pedido ${pedido.codigo}: esperado ${esperado}, pago ${pago}`);
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
    ambiente: (process.env.MP_ACCESS_TOKEN || '').startsWith('TEST-') ? 'teste' : 'producao',
  });
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Servidor rodando na porta ${PORTA}`);
  if (!process.env.MP_ACCESS_TOKEN) console.warn('Falta MP_ACCESS_TOKEN no .env');
  if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.FIREBASE_SERVICE_ACCOUNT_PATH) console.warn('Falta a chave do Firebase');
});
