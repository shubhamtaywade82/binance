import { Pool } from 'pg';

export const createSelfLearningPool = (): Pool => {
  return new Pool({
    connectionString: process.env.PG_URL,
    max: Number(process.env.SL_PG_MAX ?? 10),
  });
};
