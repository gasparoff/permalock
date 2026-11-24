// Netlify function
export { handleScan as default } from '../../src/handler.mjs';
export const config = { path: '/api/scan' };
