import { sql } from '@vercel/postgres';

export { sql };

export async function query(text, params = []) {
  const result = await sql.query(text, params);
  return result.rows;
}

export async function queryOne(text, params = []) {
  const result = await sql.query(text, params);
  return result.rows[0] || null;
}

export async function execute(text, params = []) {
  return await sql.query(text, params);
}
