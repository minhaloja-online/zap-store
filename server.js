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

// O atacado é liberado pelo TOTAL de unidades do pedido, somando produtos
// diferentes — a mesma regra do site. Um pedido com 1 un. de três produtos
// distintos já fecha no atacado.
const precoUnit = (p, totalUnidades) =>
  (temAtacado(p) && totalUnidades >= QTD_ATACADO) ? paraNumero(p.precoAtacado) : paraNumero(p.preco);

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

    // Soma as unidades antes de precificar: é o total do pedido que decide se
    // vale o preço de atacado, então precisamos saber disso antes do laço.
    const totalUnidades = pedido.itens.reduce((soma, i) => {
      const q = Number.parseInt(i.qtd, 10);
      return soma + (Number.isInteger(q) && q > 0 ? q : 0);
    }, 0);

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
      const preco = Number(precoUnit(prod, totalUnidades));
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

/* ==================== PARCELAMENTO NO BOLETO ====================
 *
 * Venda parcelada em que a LOJA controla os boletos: o vendedor aprova o
 * pedido escolhendo em quantas vezes, e a cada mês gera o boleto da parcela
 * seguinte. A Asaas emite cada boleto individualmente.
 *
 * O plano fica gravado dentro do próprio pedido, em "parcelamento.parcelas":
 * uma entrada por parcela, com vencimento, valor e situação. Parcela ainda
 * não emitida fica com status "a_gerar".
 */

// Confirma que quem está chamando é vendedor. Usado nas rotas de parcelamento,
// que emitem cobrança de verdade e não podem ficar abertas.
async function exigirVendedor(token) {
  if (!token) throw Object.assign(new Error('Faça login para continuar.'), { codigo: 401 });
  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(token)).uid;
  } catch (_) {
    throw Object.assign(new Error('Sessão expirada. Entre de novo.'), { codigo: 401 });
  }
  const ehAdmin = (await db.collection('admins').doc(uid).get()).exists;
  if (!ehAdmin) throw Object.assign(new Error('Só o vendedor pode fazer isso.'), { codigo: 403 });
  return uid;
}

// Divide o total em N parcelas sem perder centavo: a diferença do arredondamento
// vai toda para a PRIMEIRA parcela, que é a mais fácil de conferir na hora.
function dividirParcelas(total, n) {
  const centavos = Math.round(total * 100);
  const base = Math.floor(centavos / n);
  const sobra = centavos - base * n;
  return Array.from({ length: n }, (_, i) => ((i === 0 ? base + sobra : base) / 100));
}

// Vencimentos mensais a partir de uma data. Dia 31 em mês curto cai no último
// dia do mês, em vez de pular para o mês seguinte.
function vencimentosMensais(inicioISO, n) {
  const [ano, mes, dia] = inicioISO.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(ano, mes - 1 + i, 1);
    const ultimoDia = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dia, ultimoDia));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

// Emite na Asaas o boleto de uma parcela e devolve os dados para gravar
async function emitirBoletoParcela(pedido, pedidoId, parcela, totalParcelas) {
  const customerId = pedido.asaasCustomerId || await encontrarOuCriarCliente(pedido.cliente);
  const cobranca = await asaas('/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer: customerId,
      billingType: 'BOLETO',
      value: parcela.valor,
      dueDate: parcela.vencimento,
      description: `Pedido ${pedido.codigo} — parcela ${parcela.n}/${totalParcelas}`,
      externalReference: pedidoId
    })
  });
  return {
    ...parcela,
    status: 'PENDING',
    asaasId: cobranca.id,
    linkBoleto: cobranca.bankSlipUrl || cobranca.invoiceUrl,
    invoiceUrl: cobranca.invoiceUrl,
    geradoEm: new Date().toISOString(),
    customerId
  };
}

/* ---------- Criar o plano de parcelamento ---------- */
app.post('/api/criar-parcelamento', async (req, res) => {
  try {
    const { pedidoId, parcelas, token, primeiroVencimento } = req.body;
    await exigirVendedor(token);

    const n = Number.parseInt(parcelas, 10);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return res.status(400).json({ erro: 'Escolha de 1 a 10 parcelas.' });
    }

    const refPedido = db.collection('pedidos').doc(pedidoId);
    const snap = await refPedido.get();
    if (!snap.exists) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const pedido = snap.data();

    if (pedido.parcelamento) {
      return res.status(409).json({ erro: 'Este pedido já tem um parcelamento em aberto.' });
    }
    if (pedido.status !== 'aguardando_pagamento' && pedido.status !== 'pendente_aprovacao') {
      return res.status(409).json({ erro: 'Só dá para parcelar pedido que está aguardando pagamento.' });
    }
    const total = Number(pedido.total || 0);
    if (!(total > 0)) return res.status(400).json({ erro: 'Pedido sem valor.' });

    // Primeiro vencimento: o que o vendedor escolheu, ou daqui a 3 dias
    const inicio = /^\d{4}-\d{2}-\d{2}$/.test(primeiroVencimento || '')
      ? primeiroVencimento
      : new Date(Date.now() + DIAS_PARA_VENCER * 864e5).toISOString().slice(0, 10);

    const valores = dividirParcelas(total, n);
    const datas = vencimentosMensais(inicio, n);
    let lista = valores.map((valor, i) => ({
      n: i + 1, valor, vencimento: datas[i], status: 'a_gerar'
    }));

    // Só a primeira já sai emitida; as outras o vendedor gera mês a mês
    lista[0] = await emitirBoletoParcela(pedido, pedidoId, lista[0], n);

    await refPedido.update({
      status: 'parcelamento_aberto',
      parcelamento: {
        total: n,
        valorTotal: Math.round(total * 100) / 100,
        criadoEm: new Date().toISOString(),
        parcelas: lista
      },
      asaasCustomerId: lista[0].customerId,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Parcelamento criado — pedido ${pedido.codigo} — ${n}x de R$ ${valores[0]}`);
    res.json({ ok: true, linkBoleto: lista[0].linkBoleto, parcelas: lista });
  } catch (erro) {
    console.error('Falha ao criar parcelamento:', erro);
    res.status(erro.codigo || 500).json({ erro: erro.message || 'Não foi possível parcelar.' });
  }
});

/* ---------- Gerar o boleto de uma parcela ---------- */
app.post('/api/gerar-parcela', async (req, res) => {
  try {
    const { pedidoId, n, token } = req.body;
    await exigirVendedor(token);

    const refPedido = db.collection('pedidos').doc(pedidoId);
    const snap = await refPedido.get();
    if (!snap.exists) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    const pedido = snap.data();

    const plano = pedido.parcelamento;
    if (!plano) return res.status(409).json({ erro: 'Este pedido não tem parcelamento.' });

    const idx = (plano.parcelas || []).findIndex(x => x.n === Number(n));
    if (idx < 0) return res.status(404).json({ erro: 'Parcela não encontrada.' });
    if (plano.parcelas[idx].status !== 'a_gerar') {
      return res.status(409).json({ erro: 'O boleto desta parcela já foi gerado.' });
    }

    const atualizada = await emitirBoletoParcela(pedido, pedidoId, plano.parcelas[idx], plano.total);
    const novas = [...plano.parcelas];
    novas[idx] = atualizada;

    await refPedido.update({
      'parcelamento.parcelas': novas,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Boleto da parcela ${n}/${plano.total} gerado — pedido ${pedido.codigo}`);
    res.json({ ok: true, linkBoleto: atualizada.linkBoleto });
  } catch (erro) {
    console.error('Falha ao gerar parcela:', erro);
    res.status(erro.codigo || 500).json({ erro: erro.message || 'Não foi possível gerar o boleto.' });
  }
});

/* ==================== CANCELAR PEDIDO ==================== */
/*
 * O cliente desistiu de um pedido que ainda não pagou.
 *
 * Não basta marcar "cancelado" no banco: a cobrança na Asaas continuaria de pé
 * e a pessoa receberia lembrete de boleto de algo que ela mesma cancelou.
 * Aqui a cobrança é removida na Asaas antes de mexer no pedido.
 *
 * O token do Firebase prova quem está pedindo o cancelamento — sem isso,
 * qualquer um que descobrisse um ID de pedido poderia cancelar o pedido alheio.
 */
app.post('/api/cancelar-pedido', async (req, res) => {
  try {
    const { pedidoId, token } = req.body;
    if (!pedidoId || typeof pedidoId !== 'string') {
      return res.status(400).json({ erro: 'Pedido não informado.' });
    }
    if (!token) return res.status(401).json({ erro: 'Faça login para cancelar.' });

    let uid;
    try {
      const dados = await admin.auth().verifyIdToken(token);
      uid = dados.uid;
    } catch (_) {
      return res.status(401).json({ erro: 'Sessão expirada. Entre de novo e tente outra vez.' });
    }

    const refPedido = db.collection('pedidos').doc(pedidoId);
    const snap = await refPedido.get();
    if (!snap.exists) return res.status(404).json({ erro: 'Pedido não encontrado.' });

    const pedido = snap.data();

    // Vendedor pode cancelar qualquer pedido; cliente, só os dele
    const ehDono = pedido.userId && pedido.userId === uid;
    const ehAdmin = (await db.collection('admins').doc(uid).get()).exists;
    if (!ehDono && !ehAdmin) {
      return res.status(403).json({ erro: 'Este pedido não é seu.' });
    }

    // Pedido já pago não se cancela sozinho: envolve estorno e estoque baixado,
    // então precisa passar pelo vendedor.
    if (!ehAdmin && pedido.status !== 'aguardando_pagamento' && pedido.status !== 'rascunho') {
      return res.status(409).json({
        erro: 'Este pedido não pode mais ser cancelado por aqui. Fale com a loja.'
      });
    }

    // Derruba a cobrança na Asaas, se ainda estiver em aberto
    if (pedido.asaasPaymentId) {
      try {
        const cobranca = await asaas(`/payments/${pedido.asaasPaymentId}`);
        if (cobranca.status === 'PENDING' || cobranca.status === 'AWAITING_RISK_ANALYSIS') {
          await asaas(`/payments/${pedido.asaasPaymentId}`, { method: 'DELETE' });
          console.log(`Cobrança ${pedido.asaasPaymentId} cancelada (pedido ${pedido.codigo})`);
        } else if (cobranca.status === 'CONFIRMED' || cobranca.status === 'RECEIVED') {
          // Pagou entre abrir a tela e clicar em cancelar: não dá para desfazer aqui
          return res.status(409).json({
            erro: 'Este pedido já consta como pago. Fale com a loja para resolver.'
          });
        }
      } catch (e) {
        // Cobrança inexistente ou já removida: segue e cancela o pedido mesmo assim
        console.warn('Não foi possível cancelar a cobrança:', e.message);
      }
    }

    await refPedido.update({
      status: 'cancelado',
      canceladoEm: admin.firestore.FieldValue.serverTimestamp(),
      canceladoPor: ehAdmin && !ehDono ? 'vendedor' : 'cliente',
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`Pedido ${pedido.codigo} cancelado pelo ${ehDono ? 'cliente' : 'vendedor'}`);
    res.json({ ok: true });
  } catch (erro) {
    console.error('Falha ao cancelar pedido:', erro);
    res.status(500).json({ erro: 'Não foi possível cancelar o pedido.' });
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

    // ---- É a parcela de um parcelamento? ----
    // Nesse caso o valor pago é o da PARCELA, não o do pedido: comparar com o
    // total reprovaria todo pagamento. E o estoque só pode ser debitado uma
    // vez, na primeira parcela paga — não a cada mês.
    const snapPed = await refPedido.get();
    const plano = snapPed.exists ? snapPed.data().parcelamento : null;
    if (plano && (plano.parcelas || []).some(x => x.asaasId === String(payment.id))) {
      await processarParcela(refPedido, payment, status);
      return;
    }

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

/*
 * Baixa de uma parcela avisada pelo webhook.
 *
 * Roda em transação porque a Asaas pode repetir a mesma notificação, e duas
 * chamadas simultâneas poderiam debitar o estoque duas vezes.
 */
async function processarParcela(refPedido, payment, status) {
  await db.runTransaction(async tx => {
    const snap = await tx.get(refPedido);
    if (!snap.exists) return;
    const pedido = snap.data();
    const plano = pedido.parcelamento;
    if (!plano) return;

    const idx = (plano.parcelas || []).findIndex(x => x.asaasId === String(payment.id));
    if (idx < 0) return;
    if (plano.parcelas[idx].status === status) return; // nada mudou: evita reprocessar

    const parcelas = [...plano.parcelas];
    parcelas[idx] = {
      ...parcelas[idx],
      status,
      valorPago: Number(payment.value || 0),
      pagoEm: (status === 'CONFIRMED' || status === 'RECEIVED') ? new Date().toISOString() : null
    };

    const paga = p => p.status === 'CONFIRMED' || p.status === 'RECEIVED';
    const qtdPagas = parcelas.filter(paga).length;
    const todasPagas = qtdPagas === plano.total;

    const mudancas = {
      'parcelamento.parcelas': parcelas,
      'parcelamento.pagas': qtdPagas,
      atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
    };

    // Estoque sai na PRIMEIRA parcela paga: a mercadoria é entregue ali, não
    // no fim do parcelamento.
    if (qtdPagas > 0 && !pedido.estoqueBaixado) {
      const refs = (pedido.itens || []).map(i => db.collection('produtos').doc(String(i.id)));
      const snaps = refs.length ? await tx.getAll(...refs) : [];
      (pedido.itens || []).forEach((item, i) => {
        const ps = snaps[i];
        if (!ps || !ps.exists) return;
        const atual = Number(ps.data().estoque || 0);
        tx.update(refs[i], { estoque: Math.max(atual - Number(item.qtd || 0), 0) });
      });
      mudancas.estoqueBaixado = true;
      mudancas.pagoEm = admin.firestore.FieldValue.serverTimestamp();
    }

    // Quitou tudo: o pedido sai do controle de parcelas e entra na fila de envio
    if (todasPagas) {
      mudancas.status = 'pendente_envio';
      mudancas.aprovadoEm = admin.firestore.FieldValue.serverTimestamp();
      mudancas['parcelamento.quitadoEm'] = new Date().toISOString();
    }

    tx.update(refPedido, mudancas);
  });
  console.log(`Parcela do pagamento ${payment.id} atualizada para ${status}`);
}

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
