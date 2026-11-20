import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Cart from '../models/Cart.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const httpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });
const statuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
const paymentMethods = ['cash_on_delivery', 'bank_transfer', 'e_wallet'];

export const getOrders = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.user.role !== 'admin') filter.userId = req.user._id;
  if (req.query.status) {
    if (!statuses.includes(req.query.status)) throw httpError('Invalid order status filter.', 400);
    filter.status = req.query.status;
  }
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
  const [data, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'firstName lastName email').populate('items.productId', 'name category image'),
    Order.countDocuments(filter),
  ]);
  res.json({ success: true, data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
});

export const getOrderById = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError('Invalid order ID.', 400);
  const order = await Order.findById(req.params.id).populate('userId', 'firstName lastName email').populate('items.productId', 'name category image');
  if (!order) throw httpError('Order not found.', 404);
  if (req.user.role !== 'admin' && String(order.userId?._id || order.userId) !== String(req.user._id)) throw httpError('You cannot access this order.', 403);
  res.json({ success: true, data: order });
});

export const createOrder = asyncHandler(async (req, res) => {
  const { customer, shippingAddress, items, paymentMethod = 'cash_on_delivery', notes = '' } = req.body || {};
  if (!customer || !shippingAddress) throw httpError('Customer and shippingAddress are required.', 400);
  if (!Array.isArray(items) || items.length === 0) throw httpError('An order must contain at least one item.', 400);
  if (!paymentMethods.includes(paymentMethod)) throw httpError('Invalid payment method.', 400);
  if (typeof notes !== 'string') throw httpError('notes must be a string.', 400);

  // Combine duplicate product IDs before checking/decrementing inventory.
  const quantities = new Map();
  for (const item of items) {
    if (!mongoose.isValidObjectId(item?.productId)) throw httpError(`Invalid product ID: ${item?.productId ?? ''}`, 400);
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw httpError('Every order item quantity must be a positive whole number.', 400);
    const key = String(item.productId);
    quantities.set(key, (quantities.get(key) || 0) + item.quantity);
  }

  const reserved = [];
  let orderCreated = false;
  try {
    const orderItems = [];
    for (const [id, quantity] of quantities) {
      // Atomic conditional update prevents two concurrent checkouts taking the same final stock.
      const product = await Product.findOneAndUpdate(
        { _id: id, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } },
        { new: true }
      );
      if (!product) {
        const exists = await Product.exists({ _id: id });
        if (!exists) throw httpError(`Product not found: ${id}`, 404);
        const current = await Product.findById(id).select('name stock');
        throw httpError(`Insufficient stock for ${current?.name || id}; available quantity is ${current?.stock ?? 0}.`, 409);
      }
      reserved.push({ productId: product._id, quantity });
      orderItems.push({ productId: product._id, name: product.name, price: product.price, quantity, image: product.image || '' });
    }

    const order = await Order.create({
      userId: req.user._id,
      customer,
      shippingAddress,
      items: orderItems,
      paymentMethod,
      notes,
    });
    orderCreated = true;
    await Cart.findOneAndUpdate({ userId: req.user._id }, { $set: { items: [] } });
    await order.populate('userId', 'firstName lastName email');
    await order.populate('items.productId', 'name category image');
    res.status(201).json({ success: true, message: 'Order created and inventory updated.', data: order });
  } catch (error) {
    // If order creation fails after reserving stock, return each reserved quantity.
    if (!orderCreated) {
      await Promise.all(reserved.map(({ productId, quantity }) => Product.updateOne({ _id: productId }, { $inc: { stock: quantity } })));
    }
    throw error;
  }
});

export const updateOrder = asyncHandler(async (req, res) => {
  const { status, customer, shippingAddress, paymentMethod, notes } = req.body || {};
  const changes = {};
  if (status !== undefined) {
    if (!statuses.includes(status)) throw httpError('Invalid order status.', 400);
    changes.status = status;
  }
  if (customer !== undefined) changes.customer = customer;
  if (shippingAddress !== undefined) changes.shippingAddress = shippingAddress;
  if (paymentMethod !== undefined) {
    if (!paymentMethods.includes(paymentMethod)) throw httpError('Invalid payment method.', 400);
    changes.paymentMethod = paymentMethod;
  }
  if (notes !== undefined) changes.notes = notes;
  if (!Object.keys(changes).length) throw httpError('Provide status, customer, shippingAddress, paymentMethod, or notes to update.', 400);
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError('Invalid order ID.', 400);

  const order = await Order.findById(req.params.id);
  if (!order) throw httpError('Order not found.', 404);
  if (order.status === 'cancelled' && changes.status && changes.status !== 'cancelled') throw httpError('A cancelled order cannot be reopened in this demo API.', 409);

  // A cancelled order returns reserved inventory once. Reopening is intentionally disallowed.
  const shouldRestock = changes.status === 'cancelled' && order.status !== 'cancelled';
  Object.assign(order, changes);
  await order.save();
  if (shouldRestock) {
    await Promise.all(order.items.map((item) => Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } })));
  }
  await order.populate('userId', 'firstName lastName email');
  await order.populate('items.productId', 'name category image');
  res.json({ success: true, message: 'Order updated.', data: order });
});

export const deleteOrder = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError('Invalid order ID.', 400);
  const order = await Order.findById(req.params.id);
  if (!order) throw httpError('Order not found.', 404);
  // If pending/processing inventory was deducted, return it before removing the order.
  if (!['cancelled', 'shipped', 'delivered'].includes(order.status)) {
    for (const item of order.items) await Product.updateOne({ _id: item.productId }, { $inc: { stock: item.quantity } });
  }
  await order.deleteOne();
  res.json({ success: true, message: 'Order deleted.', data: { _id: order._id } });
});
