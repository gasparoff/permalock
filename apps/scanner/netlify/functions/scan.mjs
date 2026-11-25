// Netlify functions
import { handleScan } from '../../src/handler.mjs';
export default (request, context) => handleScan(request, { ip: context.ip });
export const config = { path: '/api/scan' };
