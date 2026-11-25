// Vercel function: GET /api/scan
import { handleScan } from '../src/handler.mjs';
export const GET = (request) => handleScan(request, { ip: request.headers.get('x-real-ip') ?? undefined });
