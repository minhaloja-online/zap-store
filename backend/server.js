const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const mercadopago = require('mercadopago');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fileUpload = require('express-fileupload');

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(fileUpload());

// ==================== FIREBASE ====================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (Object.keys(serviceAccount).length > 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// ==================== MERCADO PAGO ====================
mercadopago.configure({
  access_token: process.env.MERCADO_PAGO_ACCESS_TOKEN
});

// ==================== EMAIL (NODEMAILER) ====================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

// ==================== AUTENTICAÇÃO ====================
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura';

async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ==================== ROTAS DE AUTENTICAÇÃO ====================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    // Verificar se usuário já existe
    const userSnapshot = await db.collection('users').where('email', '==', email).get();
    if (!userSnapshot.empty) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }

    const hashedPassword = await hashPassword(password);
    const userId = Date.now().toString();

    await db.collection('users').doc(userId).set({
      email,
      password: hashedPassword,
      name,
      phone,
      createdAt: new Date(),
      role: 'seller'
    });

    const token = generateToken(userId);
    res.json({ token, userId, message: 'Usuário criado com sucesso' });
  } catch (error) {
    console.error('Erro ao registrar:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const userSnapshot = await db.collection('users').where('email', '==', email).get();
    if (userSnapshot.empty) {
      return res.status(400).json({ error: 'Email ou senha incorretos' });
    }

    const user = userSnapshot.docs[0];
    const userData = user.data();

    const validPassword = await comparePassword(password, userData.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Email ou senha incorretos' });
    }

    const token = generateToken(user.id);
    res.json({ token, userId: user.id, name: userData.name });
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ROTAS DE PRODUTOS ====================
app.post('/api/products', verifyToken, async (req, res) => {
  try {
    const { name, description, price, stock, category } = req.body;
    const image = req.files?.image;

    let imageUrl = null;

    // Upload da imagem para Firebase Storage
    if (image) {
      const fileName = `products/${req.userId}/${Date.now()}-${image.name}`;
      const file = bucket.file(fileName);

      await file.save(image.data, {
        metadata: {
          contentType: image.mimetype
        }
      });

      // Gerar URL pública
      imageUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;
    }

    const productId = Date.now().toString();

    await db.collection('products').doc(productId).set({
      userId: req.userId,
      name,
      description,
      price: parseFloat(price),
      stock: parseInt(stock),
      category,
      imageUrl,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    res.json({ id: productId, message: 'Produto criado com sucesso' });
  } catch (error) {
    console.error('Erro ao criar produto:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products/:userId', async (req, res) => {
  try {
    const snapshot = await db.collection('products')
      .where('userId', '==', req.params.userId)
      .get();

    const products = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(products);
  } catch (error) {
    console.error('Erro ao buscar produtos:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:productId', verifyToken, async (req, res) => {
  try {
    const { name, description, price, stock, category } = req.body;

    await db.collection('products').doc(req.params.productId).update({
      name,
      description,
      price: parseFloat(price),
      stock: parseInt(stock),
      category,
      updatedAt: new Date()
    });

    res.json({ message: 'Produto atualizado com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar produto:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:productId', verifyToken, async (req, res) => {
  try {
    await db.collection('products').doc(req.params.productId).delete();
    res.json({ message: 'Produto deletado com sucesso' });
  } catch (error) {
    console.error('Erro ao deletar produto:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CÁLCULO DE FRETE (ViaCEP + Correios) ====================
app.post('/api/shipping', async (req, res) => {
  try {
    const { cep, weight } = req.body;

    // Buscar dados do CEP
    const cepResponse = await axios.get(`https://viacep.com.br/ws/${cep}/json/`);

    if (cepResponse.data.erro) {
      return res.status(400).json({ error: 'CEP inválido' });
    }

    // Simulação de cálculo (você pode integrar com API real dos Correios)
    const basePrice = 15;
    const weightFactor = weight * 2;
    const totalShipping = basePrice + weightFactor;

    res.json({
      cep: cepResponse.data.cep,
      city: cepResponse.data.localidade,
      state: cepResponse.data.uf,
      shippingCost: parseFloat(totalShipping.toFixed(2)),
      estimatedDays: 10
    });
  } catch (error) {
    console.error('Erro ao calcular frete:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== PEDIDOS ====================
app.post('/api/orders', async (req, res) => {
  try {
    const { sellerId, items, customer, shippingCost, totalAmount } = req.body;

    const orderId = Date.now().toString();

    await db.collection('orders').doc(orderId).set({
      sellerId,
      items,
      customer,
      shippingCost,
      totalAmount,
      status: 'pending',
      paymentStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Enviar email de confirmação para o cliente
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: customer.email,
      subject: `Pedido Confirmado #${orderId}`,
      html: `
        <h2>Obrigado pela sua compra!</h2>
        <p>Seu pedido <strong>#${orderId}</strong> foi confirmado.</p>
        <h3>Itens:</h3>
        <ul>
          ${items.map(item => `<li>${item.name} x${item.quantity} - R$ ${item.price.toFixed(2)}</li>`).join('')}
        </ul>
        <p><strong>Total:</strong> R$ ${totalAmount.toFixed(2)}</p>
        <p>Você receberá atualizações sobre seu pedido em breve!</p>
      `
    });

    // Enviar email para o vendedor
    const seller = await db.collection('users').doc(sellerId).get();
    const sellerData = seller.data();

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: sellerData.email,
      subject: `Novo Pedido #${orderId}`,
      html: `
        <h2>Você recebeu um novo pedido!</h2>
        <p><strong>Cliente:</strong> ${customer.name}</p>
        <p><strong>Email:</strong> ${customer.email}</p>
        <p><strong>Telefone:</strong> ${customer.phone}</p>
        <p><strong>Endereço:</strong> ${customer.address}</p>
        <h3>Itens:</h3>
        <ul>
          ${items.map(item => `<li>${item.name} x${item.quantity} - R$ ${item.price.toFixed(2)}</li>`).join('')}
        </ul>
        <p><strong>Total:</strong> R$ ${totalAmount.toFixed(2)}</p>
      `
    });

    res.json({ orderId, message: 'Pedido criado com sucesso' });
  } catch (error) {
    console.error('Erro ao criar pedido:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders/:sellerId', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('orders')
      .where('sellerId', '==', req.params.sellerId)
      .orderBy('createdAt', 'desc')
      .get();

    const orders = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(orders);
  } catch (error) {
    console.error('Erro ao buscar pedidos:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== MERCADO PAGO ====================
app.post('/api/payment/mercado-pago', async (req, res) => {
  try {
    const { items, orderId, description, email, phone } = req.body;

    let preference = {
      items: items.map(item => ({
        id: item.id,
        title: item.name,
        currency_id: 'BRL',
        picture_url: item.imageUrl,
        description: item.description,
        category_id: 'art',
        quantity: item.quantity,
        unit_price: item.price
      })),
      payer: {
        email,
        phone: {
          area_code: '55',
          number: phone.replace(/\D/g, '')
        }
      },
      metadata: {
        orderId
      },
      notification_url: `${process.env.BACKEND_URL}/api/payment/notification`,
      back_urls: {
        success: `${process.env.FRONTEND_URL}/payment/success`,
        failure: `${process.env.FRONTEND_URL}/payment/failure`,
        pending: `${process.env.FRONTEND_URL}/payment/pending`
      },
      auto_return: 'approved'
    };

    const response = await mercadopago.preferences.create(preference);

    res.json({
      preferenceId: response.body.id,
      initPoint: response.body.init_point
    });
  } catch (error) {
    console.error('Erro ao criar preferência Mercado Pago:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/payment/notification', async (req, res) => {
  try {
    const paymentId = req.query.id;
    const status = req.query.status;

    if (paymentId) {
      const payment = await mercadopago.payment.findById(paymentId);
      const paymentData = payment.body;

      if (paymentData.status === 'approved') {
        const orderId = paymentData.metadata?.orderId;

        // Atualizar status do pedido no banco de dados
        if (orderId) {
          await db.collection('orders').doc(orderId).update({
            paymentStatus: 'paid',
            status: 'confirmed',
            updatedAt: new Date()
          });
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao processar notificação:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== RELATÓRIOS ====================
app.get('/api/reports/sales/:sellerId', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('orders')
      .where('sellerId', '==', req.params.sellerId)
      .get();

    const orders = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Calcular métricas
    const totalSales = orders.reduce((sum, order) => sum + order.totalAmount, 0);
    const totalOrders = orders.length;
    const averageOrderValue = totalOrders > 0 ? totalSales / totalOrders : 0;

    // Agrupar por mês
    const salesByMonth = {};
    orders.forEach(order => {
      const date = new Date(order.createdAt.toDate());
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      if (!salesByMonth[month]) {
        salesByMonth[month] = { total: 0, count: 0 };
      }
      salesByMonth[month].total += order.totalAmount;
      salesByMonth[month].count += 1;
    });

    res.json({
      totalSales,
      totalOrders,
      averageOrderValue,
      salesByMonth,
      orders
    });
  } catch (error) {
    console.error('Erro ao buscar relatório de vendas:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports/inventory/:sellerId', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('products')
      .where('userId', '==', req.params.sellerId)
      .get();

    const products = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Calcular métricas
    const totalProducts = products.length;
    const totalValue = products.reduce((sum, p) => sum + (p.price * p.stock), 0);
    const lowStockProducts = products.filter(p => p.stock < 5);

    const stockByCategory = {};
    products.forEach(product => {
      const category = product.category || 'Sem categoria';
      if (!stockByCategory[category]) {
        stockByCategory[category] = { count: 0, value: 0 };
      }
      stockByCategory[category].count += product.stock;
      stockByCategory[category].value += product.price * product.stock;
    });

    res.json({
      totalProducts,
      totalValue,
      lowStockProducts,
      stockByCategory,
      products
    });
  } catch (error) {
    console.error('Erro ao buscar relatório de estoque:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== INICIAR SERVIDOR ====================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
