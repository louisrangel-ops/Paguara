/**
 * Rotación de la llave de cifrado: vuelve a cifrar con la llave activa los
 * secretos guardados en la base (webhooks, doble factor, secretos de los bancos).
 *
 *   npm run secrets:rewrap            # aplica
 *   npm run secrets:rewrap -- --dry   # solo cuenta lo que cambiaría
 *
 * Rotar la llave local: SECRETS_ENCRYPTION_KEY=<nueva>, SECRETS_ENCRYPTION_PREVIOUS_KEYS=<vieja>,
 * correr esto y luego quitar la vieja. Pasar a AWS: KMS_PROVIDER=aws, KMS_KEY_ID y
 * dejar SECRETS_ENCRYPTION_KEY hasta correr esto.
 */
import { createPool } from '../src/database/database';
import { rewrapAll } from '../src/secrets/rewrap';
import { vault } from '../src/secrets/vault';

async function main() {
  const dryRun = process.argv.includes('--dry');
  const pool = createPool();
  try {
    if (vault().providerName === 'none') throw new Error('No hay llave activa: define KMS_PROVIDER/KMS_KEY_ID o SECRETS_ENCRYPTION_KEY');
    const report = await rewrapAll(pool, vault(), { dryRun });
    for (const [where, n] of Object.entries(report)) console.log(`${dryRun ? '[dry] ' : ''}${where}: ${n} vueltos a cifrar`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`[secrets:rewrap] ${(e as Error).message}`);
  process.exit(1);
});
