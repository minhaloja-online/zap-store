# 🛒 MegaStore Pro - E-commerce Profissional Completo

Um e-commerce moderno e funcional com autenticação, upload de imagens, integração Mercado Pago, cálculo de frete, email automático e relatórios de vendas/estoque.

## ✨ Funcionalidades

✅ **Autenticação segura** (Login/Registro com JWT)  
✅ **Upload de imagens** para produtos (Firebase Storage)  
✅ **Carrinho de compras** completo  
✅ **Cálculo automático de frete** (ViaCEP + Correios)  
✅ **Pagamento Mercado Pago** ou Pagar na Entrega  
✅ **Email automático** de confirmação (SendGrid/Gmail)  
✅ **Banco de dados em tempo real** (Firebase Firestore)  
✅ **Relatórios de vendas** por período  
✅ **Relatório de estoque** com avisos baixa quantidade  
✅ **Interface moderna e responsiva**  
✅ **Hospedagem na nuvem** (Grátis ou muito barato)  

---

## 🚀 Quick Start (Local)

### Pré-requisitos
- Node.js 14+ instalado
- npm ou yarn
- Conta Firebase (grátis)
- Conta Mercado Pago (grátis)

### 1. Clone o repositório

```bash
git clone https://github.com/seu-usuario/megastore.git
cd megastore
```

### 2. Configure o Backend

```bash
cd backend
npm install
```

Crie arquivo `.env`:
```
FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
FIREBASE_STORAGE_BUCKET='megastore.appspot.com'
MERCADO_PAGO_ACCESS_TOKEN='sua_chave_aqui'
EMAIL_USER='seu@email.com'
EMAIL_PASSWORD='sua_senha_aqui'
JWT_SECRET='chave_secreta_aleatoria'
FRONTEND_URL='http://localhost:3000'
BACKEND_URL='http://localhost:5000'
PORT=5000
```

Inicie o servidor:
```bash
npm start
```

Backend rodando em: `http://localhost:5000`

### 3. Configure o Frontend

Abra `frontend/index.html` no navegador ou:

```bash
cd frontend
npx http-server
```

Frontend rodando em: `http://localhost:8080`

**⚠️ Importante**: Atualize a URL da API no arquivo `index.html`:
```javascript
const API_URL = 'http://localhost:5000/api';
```

---

## 🌐 Deploy na Nuvem (Gratuito)

Consulte o arquivo `GUIA_COMPLETO_DEPLOYMENT.md` para instruções passo-a-passo sobre:

- ✅ Firebase (Banco de dados + Armazenamento)
- ✅ Mercado Pago (Integração de pagamentos)
- ✅ SendGrid (Email automático)
- ✅ Railway (Backend)
- ✅ Vercel (Frontend)

---

## 📁 Estrutura do Projeto

```
megastore/
├── backend/
│   ├── server.js              # Servidor Express principal
│   ├── package.json           # Dependências Node.js
│   ├── .env.example           # Variáveis de ambiente
│   └── .gitignore             # Arquivos a ignorar no Git
│
├── frontend/
│   ├── index.html             # Aplicação React completa
│   └── vercel.json            # Configuração Vercel
│
├── GUIA_COMPLETO_DEPLOYMENT.md  # Instruções de deployment
├── README.md                     # Este arquivo
└── LICENSE                       # MIT License
```

---

## 🔑 Variáveis de Ambiente

### Backend (.env)

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `FIREBASE_SERVICE_ACCOUNT` | JSON da chave do Firebase | `{"type":"service_account",...}` |
| `FIREBASE_STORAGE_BUCKET` | Bucket do Firebase | `megastore.appspot.com` |
| `MERCADO_PAGO_ACCESS_TOKEN` | Token Mercado Pago | `APP_USR_...` |
| `EMAIL_USER` | Email para enviar | `seu@gmail.com` |
| `EMAIL_PASSWORD` | Senha app Gmail | `xxxx xxxx xxxx xxxx` |
| `JWT_SECRET` | Chave secreta JWT | `chave_super_segura` |
| `FRONTEND_URL` | URL do frontend | `http://localhost:3000` |
| `BACKEND_URL` | URL do backend | `http://localhost:5000` |
| `PORT` | Porta do servidor | `5000` |

---

## 📚 Endpoints da API

### Autenticação
```
POST   /api/auth/register       # Criar conta
POST   /api/auth/login          # Fazer login
```

### Produtos
```
POST   /api/products            # Criar produto (com imagem)
GET    /api/products/:userId    # Listar produtos
PUT    /api/products/:productId # Atualizar produto
DELETE /api/products/:productId # Deletar produto
```

### Pedidos
```
POST   /api/orders              # Criar pedido
GET    /api/orders/:sellerId    # Listar pedidos
```

### Frete
```
POST   /api/shipping            # Calcular frete por CEP
```

### Pagamento Mercado Pago
```
POST   /api/payment/mercado-pago     # Criar preferência de pagamento
POST   /api/payment/notification     # Webhook de notificação
```

### Relatórios
```
GET    /api/reports/sales/:sellerId      # Relatório de vendas
GET    /api/reports/inventory/:sellerId  # Relatório de estoque
```

---

## 🧪 Testar Pagamento Mercado Pago

Use esses dados de teste:

**Cartão:**
- Número: `4111 1111 1111 1111`
- Validade: `12/25`
- CVV: `123`
- Nome: Qualquer um

**CPF de teste:**
- `12345678090`

---

## 🐛 Troubleshooting

### Erro: "Cannot find module 'firebase-admin'"
```bash
cd backend
npm install
```

### Erro: CORS quando faz requisição
Certifique-se que `FRONTEND_URL` está correto no `.env`

### Imagens não carregam
1. Verifique credenciais do Firebase
2. Teste upload direto no console do Firebase
3. Verifique regras do Storage (modo teste deve permitir)

### Email não é enviado
Para Gmail:
1. Ative verificação de 2 fatores
2. Gere senha de app: https://myaccount.google.com/apppasswords
3. Use a senha gerada no `.env`

---

## 💳 Integrações Incluídas

- **Firebase** - Banco de dados + armazenamento de imagens
- **Mercado Pago** - Processamento de pagamentos
- **SendGrid/Gmail** - Envio de emails
- **ViaCEP** - Cálculo de endereço por CEP
- **JWT** - Autenticação segura
- **Bcrypt** - Criptografia de senhas

---

## 📈 Escalabilidade

O projeto foi arquitetado para crescer:
- Firebase escala automaticamente
- Vercel suporta ilimitados usuários
- Railway escala conforme a demanda
- Estrutura modular permite adicionar features facilmente

---

## 📄 Licença

MIT License - Veja LICENSE para detalhes

---

## 🤝 Contribuições

Contribuições são bem-vindas! Para grandes mudanças, abra uma issue primeiro.

---

## 📞 Suporte

Dúvidas? Verifique:
1. `GUIA_COMPLETO_DEPLOYMENT.md`
2. Logs do console (F12 no navegador)
3. Logs do backend (ver terminal)

---

**Feito com ❤️ para vendedores brasileiros**

Pronto para começar? Siga o **GUIA_COMPLETO_DEPLOYMENT.md** agora! 🚀
