import L from 'leaflet';
import { useEffect, useRef } from 'react';

/**
 * 地図（国土地理院の淡色地図。APIキー不要）。
 * 線は順番どおりに結ぶ。dashed は手作業案（点線）、実線は AI案。
 */
export type MapPoint = { lat: number; lng: number; label: string; color: string };
export type MapLine = { points: { lat: number; lng: number }[]; color: string; dashed?: boolean };

export function RouteMap({
  points,
  lines = [],
  height = 260,
  onPick,
}: {
  points: MapPoint[];
  lines?: MapLine[];
  height?: number;
  /** 指定すると地図をクリックした位置を返す（位置の訂正用） */
  onPick?: (p: { lat: number; lng: number }) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, zoomSnap: 0.25 }).setView(
      [38.2682, 140.8694],
      12,
    );
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
      maxZoom: 18,
    }).addTo(m);
    m.on('click', (e) => pickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    layer.current = L.layerGroup().addTo(m);
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    for (const line of lines) {
      if (line.points.length < 2) continue;
      L.polyline(
        line.points.map((p) => [p.lat, p.lng] as [number, number]),
        { color: line.color, weight: 4, dashArray: line.dashed ? '8 8' : undefined, opacity: 0.9 },
      ).addTo(g);
    }
    for (const p of points) {
      L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div class="dot dot-sm" style="background:${p.color};border:2px solid #fff;box-shadow:0 1px 3px #0003">${escapeHtml(p.label)}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
      }).addTo(g);
    }
    const all = [...points, ...lines.flatMap((l) => l.points)];
    if (all.length > 0)
      m.fitBounds(L.latLngBounds(all.map((p) => [p.lat, p.lng] as [number, number])).pad(0.1), {
        maxZoom: 15,
        animate: false,
      });
  }, [points, lines]);

  return <div ref={el} className="map" style={{ height }} />;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
