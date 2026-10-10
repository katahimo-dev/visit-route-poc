/** お客様の色の丸（案D：カラフルな丸で見分ける） */
export const CLIENT_COLORS = ['#8bbf9f', '#e9a0b8', '#8db8e0', '#c3a3d9', '#f0b36b', '#7fc4c4', '#e6c35c', '#b0b86a'] as const;
export const colorOf = (i: number): string =>
  CLIENT_COLORS[((i % CLIENT_COLORS.length) + CLIENT_COLORS.length) % CLIENT_COLORS.length] ?? CLIENT_COLORS[0];
export const initialOf = (name: string) => name.trim().charAt(0) || '?';
