import type { Industry } from '../contracts/codes';
import type { Terms } from '../contracts/documents';

/** 業種ごとの呼び方の初期値（事業所設定で上書きできる） */
export const DEFAULT_TERMS: Record<Industry, Terms> = {
  sitter: { client: 'お客様', staff: 'シッター' },
  care: { client: '利用者さん', staff: 'ヘルパー' },
  nursing: { client: '利用者さん', staff: 'スタッフ' },
  other: { client: 'お客様', staff: 'スタッフ' },
};
