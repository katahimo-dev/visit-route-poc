import { describe, expect, it } from 'vitest';
import { osrmRouteUrl, osrmSupports, parseOsrmRoute } from './osrm';

describe('travel-time OSRM', () => {
  it('経度,緯度の順で URL を作る', () => {
    expect(osrmRouteUrl('https://osrm.example/', { lat: 38.26, lng: 140.88 }, { lat: 38.27, lng: 140.87 })).toBe(
      'https://osrm.example/route/v1/driving/140.880000,38.260000;140.870000,38.270000?overview=false&alternatives=false&steps=false',
    );
  });
  it('秒・メートルを丸めて返す', () => {
    expect(parseOsrmRoute({ code: 'Ok', routes: [{ duration: 612.4, distance: 3210.6 }] })).toEqual({
      seconds: 612,
      meters: 3211,
    });
  });
  it('ルートなし・形が違うときは null', () => {
    expect(parseOsrmRoute({ code: 'NoRoute', routes: [] })).toBeNull();
    expect(parseOsrmRoute({ code: 'Ok', routes: [] })).toBeNull();
    expect(parseOsrmRoute(null)).toBeNull();
  });
  it('車だけ聞く', () => {
    expect(osrmSupports('DRIVE')).toBe(true);
    expect(osrmSupports('BICYCLE')).toBe(false);
  });
});
