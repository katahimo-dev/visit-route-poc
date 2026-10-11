import type { Client } from '@vrp/shared';
import { colorOf, initialOf } from '../../lib/colors';

/** 訪問先の色の丸と名前（予定画面と AI案の画面で同じ見た目にする） */
export function ClientName({ client }: { client: Client | undefined }) {
  return (
    <div className="visit-name">
      <span className="dot dot-sm" style={{ background: colorOf(client?.color ?? 0) }}>
        {initialOf(client?.displayName ?? '?')}
      </span>
      <span className="ellipsis">{client?.displayName ?? '（不明）'}</span>
    </div>
  );
}
