import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';
import { pseudonym } from './pseudonym';

describe('toCsv', () => {
  it('BOM付き、カンマ・引用符をエスケープし、数式を無効化する', () => {
    expect(toCsv([['a,b', 'x"y', '=SUM(A1)', -3]])).toBe('﻿"a,b","x""y",\'=SUM(A1),-3\r\n');
  });
});
describe('pseudonym', () => {
  it('同じ鍵・IDなら同じ、元のIDを含まない', () => {
    expect(pseudonym('k', 'staff', 'abc')).toBe(pseudonym('k', 'staff', 'abc'));
    expect(pseudonym('k', 'staff', 'abc')).not.toContain('abc');
    expect(pseudonym('k2', 'staff', 'abc')).not.toBe(pseudonym('k', 'staff', 'abc'));
  });
});
