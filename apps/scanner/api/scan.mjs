// Vercel function
export { handleScan as GET } from '../src/handler.mjs';
export const config = { maxDuration: 300 };
