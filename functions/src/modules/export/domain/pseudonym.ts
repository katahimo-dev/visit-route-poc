import { createHmac } from 'node:crypto';

/** 分析用の仮名ID。事業所ごとの鍵で HMAC し、元のIDを推測できないようにする（PRD §7） */
export function pseudonym(key: string, kind: 'staff' | 'client' | 'visit', id: string): string {
  return `${kind[0]}_${createHmac('sha256', key).update(`${kind}:${id}`).digest('hex').slice(0, 10)}`;
}
