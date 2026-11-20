import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import authRoutes from './routes/authRoutes.js';
import productRoutes from './routes/productRoutes.js';
import userRoutes from './routes/userRoutes.js';
import cartRoutes from './routes/cartRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';

const app = express();
const port = Number(process.env.PORT) || 5000;

app.disable('x-powered-by');
app.use(helmet());
const allowedOrigins = String(process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
  // Allow CLI tools without an Origin header; limit browser origins to configured dev origins.
  if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(Object.assign(new Error('Origin is not allowed by CORS.'), { statusCode: 403 }));
} }));
app.use(express.json({ limit: '1mb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false }), authRoutes);

app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    message: 'SkyShop API is running.',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    time: new Date().toISOString(),
  });
});
app.use('/api/products', productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/carts', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use(notFound);
app.use(errorHandler);

async function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 24) {
    throw new Error('JWT_SECRET must contain at least 24 characters. Copy .env.example to .env and configure it.');
  }
  await connectDB();
  app.listen(port, () => console.log(`SkyShop API listening at http://localhost:${port}`));
}

start().catch((error) => {
  console.error(`Server could not start: ${error.message}`);
  process.exit(1);
});
