/**
 * デモの簡易パスワードのハッシュを出す（Secret Manager の DEMO_PASSWORD_HASH に置く。リポジトリには書かない）。
 *   firebase functions:secrets:set DEMO_PASSWORD_HASH
 *   pnpm tsx scripts/demoPasswordHash.ts <パスワード>
 */
import { demoPasswordHash } from '../functions/src/modules/org/domain/login';

const password = process.argv[2];
if (!password) {
  console.error('パスワードを指定してください');
  process.exit(1);
}
console.log(demoPasswordHash(password));
