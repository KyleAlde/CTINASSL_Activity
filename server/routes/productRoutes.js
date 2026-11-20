import { Router } from 'express';
import { createProduct, deleteProduct, getProductById, getProducts, updateProduct } from '../controllers/productController.js';
import { authorizeRoles, protect } from '../middleware/auth.js';

const router = Router();
router.get('/', getProducts);
router.get('/:id', getProductById);
router.post('/', protect, authorizeRoles('admin'), createProduct);
router.patch('/:id', protect, authorizeRoles('admin'), updateProduct);
router.delete('/:id', protect, authorizeRoles('admin'), deleteProduct);
export default router;
