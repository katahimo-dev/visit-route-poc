import { describe, expect, it } from 'vitest';
import { distanceMeters, geofenceState } from './geo';

const center = { lat: 38.2682, lng: 140.8694 };

describe('geofenceState', () => {
  it('半径内で inside、精度が悪いと前の状態のまま', () => {
    expect(geofenceState({ ...center, accuracy: 20 }, center, 100, 'outside')).toBe('inside');
    expect(geofenceState({ lat: 38.28, lng: 140.88, accuracy: 500 }, center, 100, 'inside')).toBe('inside');
  });
  it('出たとみなすのは半径の1.5倍を超えたとき', () => {
    const p = { lat: center.lat + 0.0012, lng: center.lng, accuracy: 10 }; // 約133m
    expect(distanceMeters(p, center)).toBeGreaterThan(100);
    expect(geofenceState(p, center, 100, 'inside')).toBe('inside');
    expect(geofenceState(p, center, 100, 'outside')).toBe('outside');
  });
});
