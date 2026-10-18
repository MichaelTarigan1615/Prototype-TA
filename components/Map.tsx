'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, GeoJSON, CircleMarker, Popup, useMap } from 'react-leaflet';
import Papa from 'papaparse';
import 'leaflet/dist/leaflet.css';

type StatusPeserta = 'Aktif' | 'Menunggak' | 'Tidak Aktif';

interface AggregateStat {
  target: number;
  capaian: number;
  persentase: number;
  aktif: number;
  menunggak: number;
  tidakAktif: number;
  jmlLingkungan: number;
}

const medanBounds: [[number, number], [number, number]] = [
  [3.4200, 98.4700], 
  [3.8500, 98.8200]  
];

// --- KONVERSI ANGKA ROMAWI (KOLOM 'Nomor' DI ALL KEPLING.csv) KE INTEGER ---
const romanToInt = (romanStr: string): number => {
  if (!romanStr) return 999;
  const clean = romanStr.toUpperCase().replace(/[^IVXLCDM]/g, '');
  const map: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let result = 0;
  for (let i = 0; i < clean.length; i++) {
    const curr = map[clean[i]] || 0;
    const next = map[clean[i + 1]] || 0;
    if (curr < next) result -= curr;
    else result += curr;
  }
  return result || 999;
};

// --- NORMALISASI BARIS 'ALL KEPLING.csv' AGAR PAS 151 KELURAHAN & KONSISTEN ---
const normalizeKeplingRow = (row: any) => {
  let kec = (row.Kecamatan || '').trim();
  let kel = (row.Kelurahan || '').trim();
  let nomor = (row.Nomor || '').trim();
  const kodeKepling = (row['Kepala Lingkungan'] || `${kec}-${kel}-${nomor}`).trim();

  if (kec === 'MEDAN PERJUANGAN' && (kel === 'SEI KERA HILIR' || kel === 'SIDORAME BARAT')) {
    if (nomor.startsWith('I-')) {
      kel = `${kel} I`;
      nomor = nomor.slice(2);
    } else if (nomor.startsWith('II-')) {
      kel = `${kel} II`;
      nomor = nomor.slice(3);
    }
  } else if (kec === 'MEDAN AREA' && (kel === 'SUKARAMAI' || kel === 'TEGAL SARI')) {
    if (nomor.startsWith('I-')) {
      kel = `${kel} I`;
      nomor = nomor.slice(2);
    }
  }

  return {
    ...row,
    Kecamatan: kec,
    Kelurahan: kel,
    KelurahanAsliGeo: (row.Kelurahan || '').trim(),
    Nomor: nomor,
    NomorAsli: (row.Nomor || '').trim(),
    KepalaLingkungan: kodeKepling,
    WilayahKey: `${kec}-${kel}-${nomor}`,
    LegacyWilayahKey: `${(row.Kecamatan || '').trim()}-${(row.Kelurahan || '').trim()}-${(row.Nomor || '').trim()}`
  };
};

// --- PENCOCOKAN NAMA KELURAHAN ANTARA CSV DAN GEOJSON ---
const isKelurahanMatchGeo = (geoNameRaw: string, targetKelRaw: string): boolean => {
  const g = (geoNameRaw || '').toUpperCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
  const t = (targetKelRaw || '').toUpperCase().replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!g || !t) return false;
  if (g === t) return true;
  // Fallback jika GeoJSON menggunakan nama tanpa akhiran I / II (misal SUKARAMAI vs SUKARAMAI I)
  if (t.endsWith(' I') && g === t.slice(0, -2)) return true;
  if (t.endsWith(' II') && g === t.slice(0, -3)) return true;
  return false;
};

const isPointInPolygon = (point: [number, number], polygon: [number, number][]) => {
  let x = point[0], y = point[1];
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    let xi = polygon[i][0], yi = polygon[i][1];
    let xj = polygon[j][0], yj = polygon[j][1];
    let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

const isPointInFeature = (pt: [number, number], feature: any) => {
  if (!feature || !feature.geometry) return true;
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    return isPointInPolygon(pt, geom.coordinates[0]);
  } else if (geom.type === 'MultiPolygon') {
    for (let i = 0; i < geom.coordinates.length; i++) {
      if (isPointInPolygon(pt, geom.coordinates[i][0])) return true;
    }
  }
  return false;
};

const getBoundsArray = (feature: any): [[number, number], [number, number]] => {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  const extract = (arr: any) => {
    if (typeof arr[0] === 'number') {
      if (arr[1] < minLat) minLat = arr[1];
      if (arr[1] > maxLat) maxLat = arr[1];
      if (arr[0] < minLng) minLng = arr[0];
      if (arr[0] > maxLng) maxLng = arr[0];
    } else { arr.forEach(extract); }
  };
  if (feature && feature.geometry && feature.geometry.coordinates) {
    extract(feature.geometry.coordinates);
  } else {
    return [[3.5, 98.6], [3.6, 98.7]]; 
  }
  return [[minLat, minLng], [maxLat, maxLng]];
};

const resolveStatusPeserta = (row: any, idx: number): StatusPeserta => {
  const raw = (row.Status || row.status || row.STATUS || '').toString().trim().toLowerCase();
  if (raw === 'aktif') return 'Aktif';
  if (raw === 'menunggak') return 'Menunggak';
  if (raw === 'tidak aktif' || raw === 'nonaktif' || raw === 'non-aktif') return 'Tidak Aktif';

  const nikStr = String(row.NIK || '');
  const seed = nikStr.length >= 2 ? parseInt(nikStr.slice(-2), 10) : idx;
  const mod = isNaN(seed) ? idx % 10 : seed % 10;
  if (mod < 7) return 'Aktif';
  if (mod < 9) return 'Menunggak';
  return 'Tidak Aktif';
};

const getStatusColor = (persentase: number) => {
  if (persentase >= 50) {
    return {
      hex: '#10b981',
      bgBadge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      bar: 'bg-emerald-500',
      text: 'text-emerald-600',
      label: 'Tercapai (≥50%)'
    };
  }
  if (persentase >= 20) {
    return {
      hex: '#f59e0b',
      bgBadge: 'bg-amber-100 text-amber-800 border-amber-200',
      bar: 'bg-amber-500',
      text: 'text-amber-600',
      label: 'Sedang (20-49%)'
    };
  }
  return {
    hex: '#ef4444',
    bgBadge: 'bg-red-100 text-red-800 border-red-200',
    bar: 'bg-red-500',
    text: 'text-red-600',
    label: 'Prioritas (<20%)'
  };
};

const getParticipantBadgeStyle = (status: StatusPeserta) => {
  if (status === 'Aktif') {
    return {
      bg: 'bg-emerald-50 border-emerald-200 text-emerald-800',
      badge: 'bg-emerald-100 text-emerald-800 border-emerald-300',
      borderLeft: 'border-emerald-500',
      dot: '🟢'
    };
  }
  if (status === 'Menunggak') {
    return {
      bg: 'bg-amber-50 border-amber-200 text-amber-900',
      badge: 'bg-amber-100 text-amber-800 border-amber-300',
      borderLeft: 'border-amber-500',
      dot: '🟡'
    };
  }
  return {
    bg: 'bg-red-50 border-red-200 text-red-900',
    badge: 'bg-red-100 text-red-800 border-red-300',
    borderLeft: 'border-red-500',
    dot: '🔴'
  };
};

const MapController = ({ bounds, centerTo, level }: { bounds: any, centerTo: [number, number] | null, level: string }) => {
  const map = useMap();
  useEffect(() => {
    setTimeout(() => { map.invalidateSize(); }, 300);
    if (bounds) map.flyToBounds(bounds, { duration: 1.2, maxZoom: 15 });
    else if (centerTo) map.flyTo(centerTo, 12, { duration: 1.2 });
  }, [bounds, centerTo, level, map]);
  return null;
};

const Map = () => {
  const defaultPosition: [number, number] = [3.5952, 98.6722];

  const [isHeuristic, setIsHeuristic] = useState<boolean>(true);
  const [showHelpModal, setShowHelpModal] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<'menunggak' | 'asc' | 'desc' | 'alpha'>('menunggak');
  const [popupStatusFilter, setPopupStatusFilter] = useState<'ALL' | StatusPeserta>('ALL');

  const [isLoadingData, setIsLoadingData] = useState<boolean>(true);
  const [geoDataKecamatan, setGeoDataKecamatan] = useState<any>(null);
  const [geoDataKelurahan, setGeoDataKelurahan] = useState<any>(null);
  
  const [keplingMaster, setKeplingMaster] = useState<any[]>([]); 
  const [keplingStats, setKeplingStats] = useState<Record<string, { total: number; aktif: number; menunggak: number; tidakAktif: number }>>({}); 
  const [csvData, setCsvData] = useState<any[]>([]); 
  const [kotaSummary, setKotaSummary] = useState({ total: 0, aktif: 0, menunggak: 0, tidakAktif: 0 }); 

  const [level, setLevel] = useState<'kecamatan' | 'kelurahan' | 'kepling'>('kecamatan');
  const [selectedKecamatan, setSelectedKecamatan] = useState<string | null>(null);
  const [selectedKelurahan, setSelectedKelurahan] = useState<string | null>(null);
  
  const [keplingData, setKeplingData] = useState<any[]>([]);
  const [keplingMemory, setKeplingMemory] = useState<Record<string, {lat: number, lng: number}>>({});
  const [mapBoundsTarget, setMapBoundsTarget] = useState<any>(null);
  const [mapCenterTarget, setMapCenterTarget] = useState<[number, number] | null>(null);

  const markerRefs = useRef<Record<number, any>>({});
  const [isMobile, setIsMobile] = useState(false);
  const [sheetHeight, setSheetHeight] = useState(35); 
  const [isDragging, setIsDragging] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [answerCard, setAnswerCard] = useState<any>(null);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  const startDrag = () => setIsDragging(true);

  useEffect(() => {
    const onMove = (e: TouchEvent | MouseEvent) => {
      if (!isDragging) return;
      const clientY = 'touches' in e ? e.touches[0].clientY : (e as MouseEvent).clientY;
      const vh = ((window.innerHeight - clientY) / window.innerHeight) * 100;
      if (vh >= 15 && vh <= 85) setSheetHeight(vh);
    };
    const onEnd = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      document.body.style.userSelect = 'none'; 
    } else { document.body.style.userSelect = ''; }

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  const levelRef = useRef(level);
  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    setIsLoadingData(true);
    Promise.all([
      fetch('/geojson/kecamatan_medan.geojson').then((res) => res.json()),
      fetch('/geojson/kelurahan_medan.geojson').then((res) => res.json()),
      new Promise<any[]>((resolve) => {
        Papa.parse('/ALL KEPLING.csv', {
          download: true, header: true, delimiter: ';',
          complete: (results) => {
            const normalized = results.data
              .filter((r: any) => r && r.Kecamatan && r.Kelurahan)
              .map(normalizeKeplingRow);
            resolve(normalized);
          }
        });
      }),
      new Promise<{
        stats: Record<string, { total: number; aktif: number; menunggak: number; tidakAktif: number }>;
        summary: { total: number; aktif: number; menunggak: number; tidakAktif: number };
        raw: any[];
      }>((resolve) => {
        Papa.parse('/DATA_DUMMY_TK.csv', {
          download: true, header: true, delimiter: ',',
          complete: (results) => {
            const stats: Record<string, { total: number; aktif: number; menunggak: number; tidakAktif: number }> = {};
            let total = 0, aktif = 0, menunggak = 0, tidakAktif = 0;
            const enrichedRows: any[] = [];

            results.data.forEach((row: any, idx: number) => {
              if (row.Wilayah) {
                const status = resolveStatusPeserta(row, idx);
                const enriched = { ...row, Status: status };
                enrichedRows.push(enriched);

                const wKey = row.Wilayah.trim();
                if (!stats[wKey]) {
                  stats[wKey] = { total: 0, aktif: 0, menunggak: 0, tidakAktif: 0 };
                }
                stats[wKey].total++;
                total++;

                if (status === 'Aktif') { stats[wKey].aktif++; aktif++; }
                else if (status === 'Menunggak') { stats[wKey].menunggak++; menunggak++; }
                else { stats[wKey].tidakAktif++; tidakAktif++; }
              }
            });
            resolve({ stats, summary: { total, aktif, menunggak, tidakAktif }, raw: enrichedRows });
          }
        });
      })
    ]).then(([kecGeo, kelGeo, keplingList, tkData]) => {
      setGeoDataKecamatan(kecGeo);
      setGeoDataKelurahan(kelGeo);
      setKeplingMaster(keplingList);
      setKeplingStats(tkData.stats);
      setKotaSummary(tkData.summary);
      setCsvData(tkData.raw);
      setIsLoadingData(false);
    });
  }, []);

  // --- PRE-KALKULASI STATISTIK MENGGUNAKAN KUNCI UNIK (KECAMATAN + KELURAHAN) ---
  // Mencegah tabrakan nama Kelurahan SEI MATI di Medan Labuhan vs Medan Maimun
  const statsMap = useMemo(() => {
    const kecMap: Record<string, AggregateStat> = {};
    const kelMap: Record<string, AggregateStat> = {};

    keplingMaster.forEach((k) => {
      if (!k.Kecamatan || !k.Kelurahan) return;
      const kecKey = k.Kecamatan.toUpperCase();
      const kelCompositeKey = `${k.Kecamatan.toUpperCase()}__${k.Kelurahan.toUpperCase()}`;
      const kelNameOnlyKey = k.Kelurahan.toUpperCase();

      // Membaca baik format Wilayah baru maupun format Legacy sebelum generate_dummy.js dijalankan ulang
      const st = keplingStats[k.WilayahKey] || keplingStats[k.LegacyWilayahKey] || { total: 0, aktif: 0, menunggak: 0, tidakAktif: 0 };

      if (!kecMap[kecKey]) kecMap[kecKey] = { target: 0, capaian: 0, persentase: 0, aktif: 0, menunggak: 0, tidakAktif: 0, jmlLingkungan: 0 };
      kecMap[kecKey].target += 50;
      kecMap[kecKey].capaian += st.total;
      kecMap[kecKey].aktif += st.aktif;
      kecMap[kecKey].menunggak += st.menunggak;
      kecMap[kecKey].tidakAktif += st.tidakAktif;
      kecMap[kecKey].jmlLingkungan += 1;

      if (!kelMap[kelCompositeKey]) kelMap[kelCompositeKey] = { target: 0, capaian: 0, persentase: 0, aktif: 0, menunggak: 0, tidakAktif: 0, jmlLingkungan: 0 };
      kelMap[kelCompositeKey].target += 50;
      kelMap[kelCompositeKey].capaian += st.total;
      kelMap[kelCompositeKey].aktif += st.aktif;
      kelMap[kelCompositeKey].menunggak += st.menunggak;
      kelMap[kelCompositeKey].tidakAktif += st.tidakAktif;
      kelMap[kelCompositeKey].jmlLingkungan += 1;

      // Simpan juga fallback berdasarkan nama kelurahan
      if (!kelMap[kelNameOnlyKey]) kelMap[kelNameOnlyKey] = kelMap[kelCompositeKey];
    });

    Object.keys(kecMap).forEach((k) => {
      kecMap[k].persentase = kecMap[k].target > 0 ? (kecMap[k].capaian / kecMap[k].target) * 100 : 0;
    });
    Object.keys(kelMap).forEach((k) => {
      kelMap[k].persentase = kelMap[k].target > 0 ? (kelMap[k].capaian / kelMap[k].target) * 100 : 0;
    });

    return { kecMap, kelMap };
  }, [keplingMaster, keplingStats]);

  const emptyAgg: AggregateStat = { target: 0, capaian: 0, persentase: 0, aktif: 0, menunggak: 0, tidakAktif: 0, jmlLingkungan: 0 };

  const getAggregate = (type: 'kota' | 'kecamatan' | 'kelurahan', name?: string, kecContext?: string | null): AggregateStat => {
    if (type === 'kecamatan' && name) {
      return statsMap.kecMap[name.toUpperCase()] || emptyAgg;
    }
    if (type === 'kelurahan' && name) {
      if (kecContext) {
        const compKey = `${kecContext.toUpperCase()}__${name.toUpperCase()}`;
        if (statsMap.kelMap[compKey]) return statsMap.kelMap[compKey];
      }
      return statsMap.kelMap[name.toUpperCase()] || emptyAgg;
    }
    const targetKota = 100050;
    return {
      target: targetKota,
      capaian: kotaSummary.total,
      persentase: targetKota > 0 ? (kotaSummary.total / targetKota) * 100 : 0,
      aktif: kotaSummary.aktif,
      menunggak: kotaSummary.menunggak,
      tidakAktif: kotaSummary.tidakAktif,
      jmlLingkungan: 2001
    };
  };

  const aggKota = getAggregate('kota');
  const aggKec = selectedKecamatan ? getAggregate('kecamatan', selectedKecamatan) : emptyAgg;
  const aggKel = selectedKelurahan ? getAggregate('kelurahan', selectedKelurahan, selectedKecamatan) : emptyAgg;

  const findKelurahanFeature = (kelName: string) => {
    if (!geoDataKelurahan?.features) return null;
    return geoDataKelurahan.features.find((f: any) =>
      isKelurahanMatchGeo(f.properties?.name || '', kelName)
    );
  };

  // --- MESIN PENCARI GLOBAL (KELURAHAN, KODE KEPLING, NAMA WARGA, ATAU NIK) ---
  useEffect(() => {
    if (searchQuery.length < 3) {
      setSearchResults([]);
      return;
    }
    const q = searchQuery.toLowerCase();
    const results: any[] = [];

    // 1. Cari Kelurahan (menyertakan konteks Kecamatan agar SEI MATI tidak tertukar)
    const uniqueKelPairs = Array.from(
      new Map(keplingMaster.map(k => [`${k.Kecamatan}__${k.Kelurahan}`, { kec: k.Kecamatan, kel: k.Kelurahan }])).values()
    );
    const matchedKels = uniqueKelPairs
      .filter(item => item.kel.toLowerCase().includes(q))
      .slice(0, 3);

    matchedKels.forEach(item => {
      const feature = findKelurahanFeature(item.kel);
      if (feature) results.push({ type: 'kelurahan', data: { name: item.kel, kecamatan: item.kec, feature } });
    });

    // 2. Cari Peserta (Nama TK atau NIK)
    const matchedPeserta = csvData.filter(p => 
      (p['Nama TK'] && p['Nama TK'].toLowerCase().includes(q)) || 
      (p.NIK && String(p.NIK).includes(q))
    ).slice(0, 5);
    matchedPeserta.forEach(p => results.push({ type: 'peserta', data: p }));

    setSearchResults(results);
  }, [searchQuery, csvData, geoDataKelurahan, keplingMaster]);

  const handleSelectSearchResult = (result: any) => {
    setSearchQuery(''); 
    setSearchResults([]); 
    
    if (result.type === 'kelurahan') {
      const { name, kecamatan, feature } = result.data;
      setSelectedKecamatan(kecamatan);
      const bounds = getBoundsArray(feature);
      handleSelectKelurahanFromSidebar(name, bounds, feature, kecamatan);
      setAnswerCard(null); 
    } else if (result.type === 'peserta') {
      const p = result.data;
      const parts = p.Wilayah.split('-');
      if (parts.length >= 3) {
        const kec = parts[0];
        const kel = parts[1];
        const ling = parts.slice(2).join('-');
        const masterMatch = keplingMaster.find(
          k => k.WilayahKey === p.Wilayah || k.LegacyWilayahKey === p.Wilayah
        );
        const targetKelName = masterMatch ? masterMatch.Kelurahan : kel;
        const kodeKepling = masterMatch ? masterMatch.KepalaLingkungan : (p.Kode_Kepling || p.Wilayah);
        const feature = findKelurahanFeature(targetKelName);
        
        if (feature) {
          const bounds = getBoundsArray(feature);
          setSelectedKecamatan(kec);
          handleSelectKelurahanFromSidebar(targetKelName, bounds, feature, kec);
          setAnswerCard({ ...p, Kecamatan: kec, Kelurahan: targetKelName, Lingkungan: masterMatch ? masterMatch.Nomor : ling, KodeKepling: kodeKepling });
          if (isMobile) setSheetHeight(20);
        }
      }
    }
  };

  const filterPolygonsOnly = (feature: any) => {
    const isPoly = feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon';
    if (!isPoly) return false;
    if (feature.id && typeof feature.id === 'string' && feature.id.startsWith('way')) return false;
    if (!feature.properties || !feature.properties.name) return false;
    if (feature.geometry.type === 'Polygon' && feature.geometry.coordinates[0].length === 5) return false;
    return true;
  };

  const generateKeplingData = (boundsArr: [[number, number], [number, number]], kelurahanName: string, feature: any, kecName?: string | null) => {
    const activeKec = kecName || selectedKecamatan;
    const realKeplings = keplingMaster.filter((row) => 
      row.Kelurahan.toUpperCase() === kelurahanName.toUpperCase() &&
      (!activeKec || row.Kecamatan.toUpperCase() === activeKec.toUpperCase())
    );

    const data: any[] = [];
    const newMemoryUpdates: Record<string, {lat: number, lng: number}> = {};
    const minLat = boundsArr[0][0], minLng = boundsArr[0][1];
    const maxLat = boundsArr[1][0], maxLng = boundsArr[1][1];

    realKeplings.forEach((row, i) => {
      const wKey = row.WilayahKey;
      const legKey = row.LegacyWilayahKey;
      const st = keplingStats[wKey] || keplingStats[legKey] || { total: 0, aktif: 0, menunggak: 0, tidakAktif: 0 };
      const target = 50; 
      const persentase = (st.total / target) * 100;
      const daftarPeserta = csvData.filter((d: any) => d.Wilayah === wKey || d.Wilayah === legKey);

      let lat = 0, lng = 0;
      if (keplingMemory[wKey]) {
        lat = keplingMemory[wKey].lat;
        lng = keplingMemory[wKey].lng;
      } else {
        let attempts = 0;
        let found = false;
        while (!found && attempts < 1000) {
          attempts++;
          const tLat = minLat + Math.random() * (maxLat - minLat);
          const tLng = minLng + Math.random() * (maxLng - minLng);
          if (isPointInFeature([tLng, tLat], feature)) {
            lat = tLat; lng = tLng; found = true;
          }
        }
        if (found) newMemoryUpdates[wKey] = { lat, lng };
      }

      if (lat && lng) {
        data.push({
          id: i + 1,
          nomorRomawi: row.Nomor,
          nomorUrut: romanToInt(row.Nomor),
          name: `Lingkungan ${row.Nomor}`,
          kodeKepling: row.KepalaLingkungan, // Dari kolom ke-5 ALL KEPLING.csv
          lat,
          lng,
          target,
          capaian: st.total,
          aktif: st.aktif,
          menunggak: st.menunggak,
          tidakAktif: st.tidakAktif,
          persentase,
          peserta: daftarPeserta
        });
      }
    });

    if (Object.keys(newMemoryUpdates).length > 0) setKeplingMemory(prev => ({ ...prev, ...newMemoryUpdates }));
    setKeplingData(data);
  };

  const rawKecamatanNames = useMemo(() => Array.from(new Set(keplingMaster.map(k => k.Kecamatan).filter(Boolean))), [keplingMaster]);
  const rawKelurahanNames = useMemo(() => {
    if (!selectedKecamatan) return [];
    return Array.from(new Set(
      keplingMaster
        .filter(k => k.Kecamatan.toUpperCase() === selectedKecamatan.toUpperCase())
        .map(k => k.Kelurahan)
        .filter(Boolean)
    ));
  }, [keplingMaster, selectedKecamatan]);

  const validKecamatanNames = useMemo(() => {
    const list = [...rawKecamatanNames];
    if (!isHeuristic || sortBy === 'alpha') return list.sort();
    return list.sort((a, b) => {
      const statA = getAggregate('kecamatan', a);
      const statB = getAggregate('kecamatan', b);
      if (sortBy === 'menunggak') return statB.menunggak - statA.menunggak;
      return sortBy === 'asc' ? statA.persentase - statB.persentase : statB.persentase - statA.persentase;
    });
  }, [rawKecamatanNames, isHeuristic, sortBy, statsMap]);

  const validKelurahanNames = useMemo(() => {
    const list = [...rawKelurahanNames];
    if (!isHeuristic || sortBy === 'alpha') return list.sort();
    return list.sort((a, b) => {
      const statA = getAggregate('kelurahan', a, selectedKecamatan);
      const statB = getAggregate('kelurahan', b, selectedKecamatan);
      if (sortBy === 'menunggak') return statB.menunggak - statA.menunggak;
      return sortBy === 'asc' ? statA.persentase - statB.persentase : statB.persentase - statA.persentase;
    });
  }, [rawKelurahanNames, isHeuristic, sortBy, statsMap, selectedKecamatan]);

  const sortedKeplingData = useMemo(() => {
    const list = [...keplingData];
    if (!isHeuristic) return list.sort((a, b) => a.persentase - b.persentase);
    if (sortBy === 'menunggak') return list.sort((a, b) => b.menunggak - a.menunggak);
    if (sortBy === 'asc') return list.sort((a, b) => a.persentase - b.persentase);
    if (sortBy === 'desc') return list.sort((a, b) => b.persentase - a.persentase);
    return list.sort((a, b) => a.nomorUrut - b.nomorUrut);
  }, [keplingData, isHeuristic, sortBy]);

  const handleSelectKecamatanFromSidebar = (namaKec: string, bounds: any) => {
    setLevel('kelurahan'); setSelectedKecamatan(namaKec); setSelectedKelurahan(null);
    setMapBoundsTarget(bounds); setKeplingData([]); setAnswerCard(null);
    if (isMobile) setSheetHeight(45); 
  };

  const handleSelectKelurahanFromSidebar = (namaKel: string, bounds: any, feature: any, kecOverride?: string) => {
    const activeKec = kecOverride || selectedKecamatan;
    setLevel('kepling'); setSelectedKelurahan(namaKel); setPopupStatusFilter('ALL');
    setMapBoundsTarget(bounds); generateKeplingData(bounds, namaKel, feature, activeKec); setAnswerCard(null);
    if (isMobile) setSheetHeight(45);
  };

  const handleBackToKecamatan = () => {
    setLevel('kelurahan');
    setKeplingData([]);
    setSelectedKelurahan(null);
    setAnswerCard(null);
    if (selectedKecamatan && geoDataKecamatan) {
      const kecFeature = geoDataKecamatan.features.find(
        (f: any) => f.properties?.name?.toUpperCase() === selectedKecamatan.toUpperCase()
      );
      if (kecFeature) setMapBoundsTarget(getBoundsArray(kecFeature));
    }
  };

  const handleResetToCity = () => {
    setLevel('kecamatan'); setSelectedKecamatan(null); setSelectedKelurahan(null);
    setMapBoundsTarget(null); setMapCenterTarget([...defaultPosition]); setKeplingData([]); setAnswerCard(null);
  };

  const renderStatusBreakdown = (agg: AggregateStat) => {
    if (!isHeuristic) return null;
    return (
      <div className="mt-2 pt-2 border-t border-gray-100">
        <p className="text-[9px] md:text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">
          Rincian Status Kepesertaan Wilayah Ini
        </p>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="bg-emerald-50 border border-emerald-200 rounded p-1.5 text-center">
            <p className="text-[9px] font-bold text-emerald-700">🟢 AKTIF</p>
            <p className="text-xs md:text-sm font-bold text-emerald-800">{agg.aktif.toLocaleString('id-ID')}</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded p-1.5 text-center">
            <p className="text-[9px] font-bold text-amber-700">🟡 MENUNGGAK</p>
            <p className="text-xs md:text-sm font-bold text-amber-800">{agg.menunggak.toLocaleString('id-ID')}</p>
          </div>
          <div className="bg-red-50 border border-red-200 rounded p-1.5 text-center">
            <p className="text-[9px] font-bold text-red-700">🔴 NON-AKTIF</p>
            <p className="text-xs md:text-sm font-bold text-red-800">{agg.tidakAktif.toLocaleString('id-ID')}</p>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col md:flex-row w-full h-[100dvh] relative bg-gray-50 overflow-hidden">
      
      {/* --- AREA PETA --- */}
      <div className="w-full md:w-3/4 h-full relative bg-gray-100 z-0">

        {/* SWITCHER MODE EVALUASI SKRIPSI */}
        <div className="absolute top-3 left-14 z-[1000] bg-white/95 backdrop-blur shadow-md rounded-lg p-1.5 border border-gray-200 flex items-center gap-1.5 text-xs">
          <span className="font-bold text-gray-600 px-1.5 hidden sm:inline">Mode Evaluasi:</span>
          <button
            onClick={() => setIsHeuristic(true)}
            className={`px-2.5 py-1 rounded-md font-bold transition ${
              isHeuristic ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            ✨ Heuristic-Based
          </button>
          <button
            onClick={() => setIsHeuristic(false)}
            className={`px-2.5 py-1 rounded-md font-bold transition ${
              !isHeuristic ? 'bg-gray-800 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Baseline (Non-Heuristik)
          </button>
        </div>

        {/* H3: TOMBOL RESET TAMPILAN PETA */}
        {isHeuristic && (level !== 'kecamatan' || answerCard) && (
          <button
            onClick={handleResetToCity}
            className="absolute top-3 right-3 z-[1000] bg-white hover:bg-blue-50 text-blue-800 font-bold text-xs px-3 py-2 rounded-lg shadow-md border border-blue-200 flex items-center gap-1.5 transition"
          >
            <span>🔄</span> Reset Peta Kota
          </button>
        )}

        {/* H1: INDIKATOR MUAT DATA */}
        {isHeuristic && isLoadingData && (
          <div className="absolute inset-0 z-[1001] bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center">
            <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3"></div>
            <p className="text-sm font-bold text-gray-800">Memuat Master Kepling & Data Kepesertaan...</p>
            <p className="text-xs text-gray-500 mt-1">21 Kecamatan • 151 Kelurahan • 2.001 Kepala Lingkungan</p>
          </div>
        )}

        {/* H1, H2, H6: LEGENDA PETA */}
        {isHeuristic && (
          <div className="absolute bottom-20 md:bottom-6 left-3 z-[1000] bg-white/95 backdrop-blur p-3 rounded-xl shadow-lg border border-gray-200 text-xs w-56">
            <p className="font-bold text-gray-800 mb-1.5 text-[11px] uppercase tracking-wider border-b pb-1">
              Legenda Peta & Status
            </p>
            <p className="text-[10px] font-semibold text-gray-500 mb-1">Capaian Akuisisi Wilayah:</p>
            <div className="space-y-1 mb-2">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm bg-emerald-500 inline-block border border-white shadow-sm"></span>
                <span className="text-gray-700 text-[11px]">Tercapai (≥ 50%)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm bg-amber-500 inline-block border border-white shadow-sm"></span>
                <span className="text-gray-700 text-[11px]">Sedang (20% – 49.9%)</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm bg-red-500 inline-block border border-white shadow-sm"></span>
                <span className="text-gray-700 text-[11px]">Prioritas (&lt; 20%)</span>
              </div>
            </div>
            <p className="text-[10px] font-semibold text-gray-500 mb-1 border-t pt-1">Status Kepesertaan Warga:</p>
            <div className="flex justify-between text-[10px] font-bold text-gray-700">
              <span>🟢 Aktif</span>
              <span>🟡 Menunggak</span>
              <span>🔴 Non-Aktif</span>
            </div>
          </div>
        )}
        
        {/* KARTU JAWABAN PENCARIAN PESERTA */}
        {answerCard && (
          <div className={`absolute top-14 left-1/2 transform -translate-x-1/2 z-[1000] bg-white rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.3)] border-l-4 ${
            isHeuristic ? getParticipantBadgeStyle(answerCard.Status || 'Aktif').borderLeft : 'border-blue-600'
          } p-4 w-11/12 md:w-80 animate-fadeIn`}>
            <button onClick={() => setAnswerCard(null)} className="absolute top-2 right-3 text-gray-400 hover:text-red-500 font-bold">✕</button>
            <p className="text-[10px] font-bold text-blue-600 uppercase tracking-widest mb-1 flex items-center gap-1">
               <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
               Data Peserta Ditemukan
            </p>
            <h3 className="font-bold text-lg text-gray-800 leading-tight">{answerCard['Nama TK']}</h3>
            <p className="text-xs text-gray-500 mb-2.5 font-mono">
              NIK: {answerCard.NIK} {isHeuristic && answerCard.Pekerjaan ? `• ${answerCard.Pekerjaan}` : ''}
            </p>

            {isHeuristic ? (
              <div className={`p-2.5 rounded-lg border text-xs ${getParticipantBadgeStyle(answerCard.Status || 'Aktif').bg}`}>
                <div className="flex justify-between items-center mb-1.5 pb-1 border-b border-black/10">
                  <span className="font-semibold">Status Kepesertaan:</span>
                  <span className={`font-bold px-2 py-0.5 rounded border text-[11px] ${getParticipantBadgeStyle(answerCard.Status || 'Aktif').badge}`}>
                    {getParticipantBadgeStyle(answerCard.Status || 'Aktif').dot} {answerCard.Status || 'Aktif'}
                  </span>
                </div>
                <span className="block text-gray-700">Kecamatan: <b>{answerCard.Kecamatan}</b></span>
                <span className="block text-gray-700">Kelurahan: <b>{answerCard.Kelurahan}</b></span>
                <span className="block text-gray-700">Lingkungan: <b>Romawi {answerCard.Lingkungan}</b></span>
                {answerCard.KodeKepling && (
                  <span className="block text-[10px] text-gray-500 font-mono mt-0.5">
                    ID Kepling: {answerCard.KodeKepling}
                  </span>
                )}
                {answerCard.Status === 'Menunggak' && (
                  <p className="mt-1.5 text-[10px] font-bold text-amber-800 bg-amber-100/80 px-2 py-1 rounded">
                    ⚠️ Menunggak {answerCard['Bulan Menunggak'] || 1} bulan iuran — perlu tindak lanjut Kepling.
                  </p>
                )}
              </div>
            ) : (
              <div className="bg-blue-50 p-2.5 rounded border border-blue-100 text-xs text-gray-700">
                <span className="block font-bold text-blue-800 mb-1">Status: Teregistrasi di BPJS</span>
                <span className="block text-gray-600">Kecamatan: <b>{answerCard.Kecamatan}</b></span>
                <span className="block text-gray-600">Kelurahan: <b>{answerCard.Kelurahan}</b></span>
                <span className="block text-gray-600">Lingkungan: <b>{answerCard.Lingkungan}</b></span>
              </div>
            )}
          </div>
        )}

        <MapContainer center={defaultPosition} zoom={12} minZoom={11} maxBounds={medanBounds} maxBoundsViscosity={1.0} className="w-full h-full z-0 pb-16 md:pb-0">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <MapController bounds={mapBoundsTarget} centerTo={mapCenterTarget} level={level} />

          {/* LAYER KECAMATAN */}
          {geoDataKecamatan && level === 'kecamatan' && (
            <GeoJSON 
              key={`layer-kecamatan-${isHeuristic ? 'heuristik' : 'baseline'}-${kotaSummary.total}`}
              data={geoDataKecamatan}
              filter={filterPolygonsOnly}
              style={(feature: any) => {
                if (!isHeuristic) {
                  return { fillColor: "#3b82f6", weight: 2, color: 'white', fillOpacity: 0.4 };
                }
                const namaKec = feature?.properties?.name || "";
                const stat = getAggregate('kecamatan', namaKec);
                const statusColor = getStatusColor(stat.persentase);
                return { fillColor: statusColor.hex, weight: 2, color: 'white', fillOpacity: 0.55 };
              }}
              onEachFeature={(feature, layer) => {
                const namaKec = feature.properties.name || "Kecamatan";
                const stat = getAggregate('kecamatan', namaKec);
                
                const tooltipContent = isHeuristic
                  ? `<div class="text-center">
                      <b>Kec. ${namaKec}</b> (${stat.jmlLingkungan} Lingk.)<br/>
                      Akuisisi: ${stat.capaian.toLocaleString('id-ID')} / ${stat.target.toLocaleString('id-ID')} (${stat.persentase.toFixed(1)}%)<br/>
                      <span style="color:#059669">🟢 Aktif: ${stat.aktif}</span> | <span style="color:#d97706">🟡 Menunggak: ${stat.menunggak}</span>
                    </div>`
                  : namaKec;

                layer.bindTooltip(tooltipContent, { direction: "center", className: "font-bold text-xs" });
                layer.on({
                  mouseover: (e) => {
                    const l = e.target;
                    l.setStyle({ fillOpacity: 0.8, weight: 3, color: '#1e293b' });
                    l.bringToFront();
                  },
                  mouseout: (e) => {
                    const l = e.target;
                    l.setStyle({ fillOpacity: isHeuristic ? 0.55 : 0.4, weight: 2, color: 'white' });
                  },
                  click: () => { 
                    const boundsArr = getBoundsArray(feature);
                    handleSelectKecamatanFromSidebar(namaKec, boundsArr); 
                  }
                });
              }}
            />
          )}

          {/* LAYER KELURAHAN */}
          {geoDataKelurahan && (level === 'kelurahan' || level === 'kepling') && (
            <GeoJSON 
              key={`layer-kelurahan-${isHeuristic ? 'heuristik' : 'baseline'}-${selectedKecamatan}-${selectedKelurahan || 'semua'}`}
              data={geoDataKelurahan} 
              filter={(feature: any) => {
                if (!filterPolygonsOnly(feature)) return false;
                const geoName = feature.properties.name || "";
                return rawKelurahanNames.some(kel => isKelurahanMatchGeo(geoName, kel));
              }} 
              style={(feature: any) => {
                const geoName = feature.properties.name || "Kelurahan";
                const matchedKelName = rawKelurahanNames.find(kel => isKelurahanMatchGeo(geoName, kel)) || geoName;
                const isSelected = selectedKelurahan && isKelurahanMatchGeo(geoName, selectedKelurahan);
                const stat = getAggregate('kelurahan', matchedKelName, selectedKecamatan);
                const statusColor = getStatusColor(stat.persentase);

                if (level === 'kepling') {
                  const activeColor = isHeuristic ? statusColor.hex : "#10b981";
                  return {
                    fillColor: isSelected ? activeColor : "transparent",
                    weight: isSelected ? 2.5 : 0,
                    color: isSelected ? '#ffffff' : 'transparent',
                    fillOpacity: isSelected ? 0.35 : 0
                  };
                }
                if (!isHeuristic) {
                  return { fillColor: "#38bdf8", weight: 1, color: '#ffffff', fillOpacity: 0.4 };
                }
                return { fillColor: statusColor.hex, weight: 1.5, color: '#ffffff', fillOpacity: 0.55 };
              }}
              onEachFeature={(feature, layer) => {
                const geoName = feature.properties.name || "Kelurahan";
                const matchedKelName = rawKelurahanNames.find(kel => isKelurahanMatchGeo(geoName, kel)) || geoName;
                const stat = getAggregate('kelurahan', matchedKelName, selectedKecamatan);
                const tooltipContent = isHeuristic
                  ? `<div class="text-center">
                      <b>Kel. ${matchedKelName}</b> (${stat.jmlLingkungan} Lingk.)<br/>
                      Akuisisi: ${stat.capaian.toLocaleString('id-ID')} / ${stat.target.toLocaleString('id-ID')} (${stat.persentase.toFixed(1)}%)<br/>
                      <span style="color:#059669">🟢 Aktif: ${stat.aktif}</span> | <span style="color:#d97706">🟡 Menunggak: ${stat.menunggak}</span>
                    </div>`
                  : `Kel. ${matchedKelName}`;

                layer.bindTooltip(tooltipContent, { direction: "auto" });
                layer.on({
                  mouseover: (e) => {
                    if (levelRef.current === 'kelurahan') {
                      const l = e.target;
                      l.setStyle({ fillOpacity: 0.8, weight: 2.5, color: '#1e293b' });
                      l.bringToFront();
                    }
                  },
                  mouseout: (e) => {
                    if (levelRef.current === 'kelurahan') {
                      const l = e.target;
                      l.setStyle({ fillOpacity: isHeuristic ? 0.55 : 0.4, weight: 1.5, color: '#ffffff' });
                    }
                  },
                  click: () => {
                    const boundsArr = getBoundsArray(feature);
                    handleSelectKelurahanFromSidebar(matchedKelName, boundsArr, feature);
                  }
                });
              }}
            />
          )}

          {/* LAYER TITIK LINGKUNGAN / KEPLING */}
          {level === 'kepling' && sortedKeplingData.map((kep) => {
            const statusColor = getStatusColor(kep.persentase);
            const markerColor = isHeuristic ? statusColor.hex : (kep.persentase >= 50 ? '#10b981' : '#ef4444');
            
            const filteredPeserta = isHeuristic && popupStatusFilter !== 'ALL'
              ? (kep.peserta || []).filter((p: any) => p.Status === popupStatusFilter)
              : (kep.peserta || []);

            return (
              <CircleMarker 
                key={kep.id}
                center={[kep.lat, kep.lng]}
                radius={9}
                color="white"
                weight={2}
                fillColor={markerColor}
                fillOpacity={1}
                ref={(ref) => { if (ref) markerRefs.current[kep.id] = ref; }}
                eventHandlers={{ 
                  click: (e) => {
                    e.originalEvent.stopPropagation();
                    if (isMobile) setSheetHeight(15); 
                  }
                }}
              >
                <Popup autoPan={true}>
                  <div className="w-64 font-sans">
                    <h3 className="font-bold text-base text-center text-gray-800">{kep.name}</h3>
                    {isHeuristic && (
                      <p className="text-[10px] text-center text-blue-700 font-mono bg-blue-50 py-0.5 px-1.5 rounded border border-blue-100 mt-0.5 mb-1.5">
                        ID: {kep.kodeKepling}
                      </p>
                    )}
                    <hr className="mb-2"/>
                    <div className="flex justify-between text-xs mb-1"><span className="text-gray-600">Target Lingkungan:</span><b>{kep.target} Peserta</b></div>
                    <div className="flex justify-between text-xs"><span className="text-gray-600">Total Terdaftar:</span><b className="text-blue-600">{kep.capaian} Peserta</b></div>
                    <div className={`mt-1.5 px-2 py-1 rounded text-white text-center text-xs font-bold ${isHeuristic ? statusColor.bar : (kep.persentase >= 50 ? 'bg-green-500' : 'bg-red-500')}`}>
                      {kep.persentase.toFixed(1)}% Terealisasi
                    </div>

                    {/* FILTER CEPAT STATUS PESERTA UNTUK KEPALA LINGKUNGAN */}
                    {isHeuristic && (
                      <div className="mt-2.5 pt-2 border-t border-gray-200" onClick={(e) => e.stopPropagation()}>
                        <p className="text-[10px] font-bold text-gray-500 mb-1 uppercase">Filter Status Warga:</p>
                        <div className="grid grid-cols-4 gap-1 text-[10px] font-bold">
                          <button
                            onClick={() => setPopupStatusFilter('ALL')}
                            className={`py-1 rounded border transition ${popupStatusFilter === 'ALL' ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                          >
                            Semua ({kep.capaian})
                          </button>
                          <button
                            onClick={() => setPopupStatusFilter('Menunggak')}
                            className={`py-1 rounded border transition ${popupStatusFilter === 'Menunggak' ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100'}`}
                          >
                            🟡 {kep.menunggak}
                          </button>
                          <button
                            onClick={() => setPopupStatusFilter('Tidak Aktif')}
                            className={`py-1 rounded border transition ${popupStatusFilter === 'Tidak Aktif' ? 'bg-red-500 text-white border-red-500' : 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'}`}
                          >
                            🔴 {kep.tidakAktif}
                          </button>
                          <button
                            onClick={() => setPopupStatusFilter('Aktif')}
                            className={`py-1 rounded border transition ${popupStatusFilter === 'Aktif' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'}`}
                          >
                            🟢 {kep.aktif}
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="mt-2.5 pt-2 border-t border-gray-200">
                      <p className="text-[10px] font-bold text-gray-500 mb-1">
                        DAFTAR WARGA ({filteredPeserta.length}):
                      </p>
                      <div className="max-h-36 overflow-y-auto border border-gray-200 rounded bg-gray-50 p-1 custom-scrollbar" onTouchStart={(e) => e.stopPropagation()}>
                        {filteredPeserta.length > 0 ? (
                          filteredPeserta.map((p: any, idx: number) => {
                            const pBadge = getParticipantBadgeStyle(p.Status || 'Aktif');
                            const tunggakan = Number(p['Bulan Menunggak'] || 0);
                            return (
                              <div key={idx} className="border-b border-gray-200 last:border-0 py-1.5 px-1 hover:bg-gray-100 transition flex justify-between items-center gap-1">
                                <div>
                                  <div className="font-bold text-gray-700 text-xs leading-tight">{p['Nama TK']}</div>
                                  <div className="text-gray-500 text-[10px] mt-0.5">
                                    {isHeuristic && p.Pekerjaan ? `${p.Pekerjaan} • ` : ''}
                                    <span className="font-mono">NIK: {p.NIK}</span>
                                  </div>
                                </div>
                                {isHeuristic && (
                                  <div className="text-right">
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border whitespace-nowrap inline-block ${pBadge.badge}`}>
                                      {p.Status}
                                    </span>
                                    {p.Status === 'Menunggak' && tunggakan > 0 && (
                                      <span className="block text-[9px] text-amber-700 font-semibold mt-0.5">
                                        {tunggakan} bln
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <div className="text-center text-gray-400 text-xs py-3 font-medium">
                            Tidak ada peserta pada kategori ini
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>

      {/* --- PANEL SISI / BOTTOM SHEET DRAGGABLE --- */}
      <div 
        className="w-full md:w-1/4 bg-blue-900 shadow-[0_-10px_40px_rgba(0,0,0,0.2)] md:shadow-2xl z-[1000] flex flex-col absolute md:relative bottom-0 right-0 rounded-t-3xl md:rounded-none"
        style={isMobile ? { height: `${sheetHeight}vh`, transition: isDragging ? 'none' : 'height 0.3s ease-out' } : { height: '100%' }}
      >
        <div 
          className="md:hidden h-[48px] flex flex-col items-center justify-center bg-blue-950 rounded-t-3xl cursor-ns-resize flex-shrink-0 touch-none"
          onMouseDown={startDrag} onTouchStart={startDrag}
        >
          <div className="w-12 h-1.5 bg-blue-300 rounded-full mb-1 opacity-80 pointer-events-none"></div>
          <span className="text-blue-100 text-[10px] font-bold uppercase tracking-widest pointer-events-none">Geser untuk Menyesuaikan</span>
        </div>

        {/* HEADER PANEL KANAN */}
        <div className="bg-blue-950 p-4 md:p-5 border-b border-blue-800 flex-shrink-0 relative">
          <div className="flex justify-between items-start mb-3">
            <div className="text-white">
              <h1 className="text-lg md:text-xl font-bold leading-tight">Dashboard UCJ 2026</h1>
              <p className="text-blue-300 text-xs mt-0.5">
                {isHeuristic ? 'Panel Pembina & Kepala Lingkungan' : 'BPJS Ketenagakerjaan Medan'}
              </p>
            </div>
            {isHeuristic && (
              <button
                onClick={() => setShowHelpModal(true)}
                className="bg-blue-800 hover:bg-blue-700 text-blue-100 text-xs font-bold px-2.5 py-1.5 rounded-lg border border-blue-600 transition flex items-center gap-1"
              >
                <span>?</span> Panduan
              </button>
            )}
          </div>

          {/* KOLOM PENCARIAN */}
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-4 w-4 text-blue-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </div>
            <input
              type="text"
              className="block w-full pl-9 pr-8 py-2 border border-blue-700 rounded-lg leading-5 bg-blue-900 text-blue-100 placeholder-blue-400 focus:outline-none focus:bg-white focus:text-gray-900 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 sm:text-sm transition-colors duration-200"
              placeholder="Cari Nama Warga, NIK, atau Kelurahan..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {isHeuristic && searchQuery.length > 0 && (
              <button
                onClick={() => { setSearchQuery(''); setSearchResults([]); }}
                className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-blue-300 hover:text-red-400 font-bold"
              >
                ✕
              </button>
            )}
            
            {isHeuristic && searchQuery.length > 0 && searchQuery.length < 3 && (
              <div className="absolute z-50 mt-1 w-full bg-white rounded-md shadow-lg border border-gray-200 p-2.5 text-xs text-gray-500">
                Ketik minimal <b>3 karakter</b> untuk mencari Nama Warga, NIK, atau Kelurahan...
              </div>
            )}

            {searchResults.length > 0 && (
              <div className="absolute z-50 mt-1 w-full bg-white rounded-md shadow-lg border border-gray-200 max-h-60 overflow-auto">
                <ul className="py-1 text-sm text-gray-700">
                  {searchResults.map((res, idx) => (
                    <li 
                      key={idx} 
                      className="px-4 py-2 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-0"
                      onClick={() => handleSelectSearchResult(res)}
                    >
                      {res.type === 'kelurahan' ? (
                        <div>
                          <span className="font-bold text-emerald-700 block">🗺️ Kel. {res.data.name}</span>
                          <span className="text-[10px] text-gray-500">Kec. {res.data.kecamatan} • Klik untuk buka peta</span>
                        </div>
                      ) : (
                        <div className="flex justify-between items-center">
                          <div>
                            <span className="font-bold text-blue-700 block">🧑‍💼 {res.data['Nama TK']}</span>
                            <span className="text-[10px] text-gray-500 font-mono block mt-0.5">NIK: {res.data.NIK}</span>
                          </div>
                          {isHeuristic && res.data.Status && (
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${getParticipantBadgeStyle(res.data.Status).badge}`}>
                              {res.data.Status}
                            </span>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isHeuristic && searchQuery.length >= 3 && searchResults.length === 0 && (
              <div className="absolute z-50 mt-1 w-full bg-white rounded-md shadow-lg border border-red-200 p-3 text-center">
                <p className="text-xs font-bold text-red-600 mb-1">Data &ldquo;{searchQuery}&rdquo; Tidak Ditemukan</p>
                <p className="text-[11px] text-gray-500 mb-2">
                  Pastikan ejaan Nama Kelurahan benar atau masukkan nomor NIK warga yang terdaftar.
                </p>
                <button
                  onClick={() => setSearchQuery('')}
                  className="text-[11px] bg-red-50 hover:bg-red-100 text-red-700 font-semibold px-2.5 py-1 rounded border border-red-200 transition"
                >
                  Reset Pencarian
                </button>
              </div>
            )}
          </div>
        </div>

        {/* H3: STICKY BREADCRUMB NAVIGATION */}
        {isHeuristic && (
          <div className="bg-blue-900/90 px-4 py-2 border-b border-blue-800 text-[11px] text-blue-100 flex items-center gap-1 flex-wrap flex-shrink-0">
            <button
              onClick={handleResetToCity}
              className={`hover:underline font-semibold ${level === 'kecamatan' ? 'text-white font-bold' : 'text-blue-300'}`}
            >
              🏠 Kota Medan
            </button>
            {selectedKecamatan && (
              <>
                <span className="text-blue-400">/</span>
                <button
                  onClick={handleBackToKecamatan}
                  className={`hover:underline font-semibold truncate max-w-[110px] ${level === 'kelurahan' ? 'text-white font-bold' : 'text-blue-300'}`}
                >
                  Kec. {selectedKecamatan}
                </button>
              </>
            )}
            {selectedKelurahan && (
              <>
                <span className="text-blue-400">/</span>
                <span className="text-white font-bold truncate max-w-[110px]">
                  Kel. {selectedKelurahan}
                </span>
              </>
            )}
          </div>
        )}

        {/* KONTEN UTAMA SIDEBAR */}
        <div className="flex-1 overflow-y-auto bg-gray-50 block">
          
          {/* ================= LEVEL 1: KOTA / KECAMATAN ================= */}
          {level === 'kecamatan' && (
            <div className="animate-fadeIn">
              <div className="bg-white p-3 md:p-4 border-b border-gray-200 shadow-sm">
                <p className="text-[10px] md:text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Agregat Kota Medan</p>
                <div className="grid grid-cols-3 gap-1 md:gap-2 mb-2">
                  <div className="border rounded p-1.5 text-center bg-gray-50">
                    <p className="text-[8px] md:text-[10px] text-gray-500 font-semibold">KECAMATAN</p>
                    <p className="text-sm md:text-base font-bold text-gray-800">21</p>
                  </div>
                  <div className="border rounded p-1.5 text-center bg-gray-50">
                    <p className="text-[8px] md:text-[10px] text-gray-500 font-semibold">KELURAHAN</p>
                    <p className="text-sm md:text-base font-bold text-gray-800">151</p>
                  </div>
                  <div className="border rounded p-1.5 text-center bg-gray-50">
                    <p className="text-[8px] md:text-[10px] text-gray-500 font-semibold">LINGKUNGAN</p>
                    <p className="text-sm md:text-base font-bold text-gray-800">2.001</p>
                  </div>
                </div>
                <div className="flex gap-1 md:gap-2 mb-2">
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TARGET PESERTA</p>
                    <p className="text-sm md:text-base font-bold text-gray-800">100.050</p>
                  </div>
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TOTAL AKUISISI</p>
                    <p className="text-sm md:text-base font-bold text-blue-600">{aggKota.capaian.toLocaleString('id-ID')}</p>
                  </div>
                </div>
                <div className="border rounded p-2">
                   <p className="text-[10px] md:text-xs text-gray-500 font-semibold flex justify-between items-center">
                     <span>PERSENTASE CAPAIAN</span>
                     <span className={`text-sm md:text-base font-bold ${isHeuristic ? getStatusColor(aggKota.persentase).text : (aggKota.persentase >= 50 ? 'text-green-500' : 'text-red-500')}`}>
                       {aggKota.persentase.toFixed(1)}%
                     </span>
                   </p>
                   <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
                      <div className={`h-1.5 rounded-full ${isHeuristic ? getStatusColor(aggKota.persentase).bar : (aggKota.persentase >= 50 ? 'bg-green-500' : 'bg-red-500')}`} style={{ width: `${Math.min(aggKota.persentase, 100)}%` }}></div>
                   </div>
                </div>

                {renderStatusBreakdown(aggKota)}
              </div>

              <div className="p-3 md:p-4 pb-8">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm md:text-base font-bold text-gray-800">Pilih Kecamatan (21)</h2>
                  {isHeuristic && (
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as any)}
                      className="text-[11px] bg-white border border-gray-300 rounded-md px-2 py-1 text-gray-700 font-semibold focus:outline-none focus:border-blue-500"
                    >
                      <option value="menunggak">⚠️ Menunggak Terbanyak</option>
                      <option value="asc">Capaian Terendah</option>
                      <option value="desc">Capaian Tertinggi</option>
                      <option value="alpha">Abjad (A-Z)</option>
                    </select>
                  )}
                </div>

                <div className="space-y-2 mt-2">
                  {validKecamatanNames.map((kec, idx) => {
                    const stat = getAggregate('kecamatan', kec);
                    const statusColor = getStatusColor(stat.persentase);
                    return (
                      <button 
                        key={idx} 
                        onClick={() => {
                          const feature = geoDataKecamatan?.features.find((f:any) => f.properties?.name?.toUpperCase() === kec.toUpperCase());
                          const bounds = getBoundsArray(feature);
                          handleSelectKecamatanFromSidebar(kec, bounds);
                        }} 
                        className="w-full text-left bg-white shadow-sm hover:bg-blue-50 border border-gray-200 p-2.5 md:p-3 rounded-lg transition"
                      >
                        <div className="flex justify-between items-center">
                          <span className="text-xs md:text-sm font-semibold text-gray-800">
                            Kecamatan {kec}
                          </span>
                          {isHeuristic && (
                            <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${statusColor.bgBadge}`}>
                              {stat.persentase.toFixed(1)}%
                            </span>
                          )}
                        </div>
                        {isHeuristic && (
                          <div className="mt-1.5">
                            <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                              <span>Akuisisi: <b>{stat.capaian.toLocaleString('id-ID')}</b> / {stat.target.toLocaleString('id-ID')}</span>
                              <span>{stat.jmlLingkungan} Kepling</span>
                            </div>
                            <div className="w-full bg-gray-100 rounded-full h-1.5 mb-2">
                              <div className={`h-1.5 rounded-full ${statusColor.bar}`} style={{ width: `${Math.min(stat.persentase, 100)}%` }}></div>
                            </div>
                            <div className="flex gap-1.5 text-[10px] font-semibold">
                              <span className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200">
                                🟢 Aktif: {stat.aktif}
                              </span>
                              <span className="bg-amber-50 text-amber-800 px-1.5 py-0.5 rounded border border-amber-200">
                                🟡 Menunggak: {stat.menunggak}
                              </span>
                              <span className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded border border-red-200">
                                🔴 {stat.tidakAktif}
                              </span>
                            </div>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ================= LEVEL 2: KELURAHAN ================= */}
          {level === 'kelurahan' && (
            <div className="animate-fadeIn">
              <div className="bg-white p-3 md:p-4 border-b border-gray-200 shadow-sm">
                <p className="text-[10px] md:text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Agregat Kec. {selectedKecamatan}</p>
                <div className="flex gap-1 md:gap-2 mb-2">
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TARGET ({aggKec.jmlLingkungan} KEPLING)</p>
                    <p className="text-sm md:text-base font-bold text-gray-800">{aggKec.target.toLocaleString('id-ID')}</p>
                  </div>
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">CAPAIAN</p>
                    <p className="text-sm md:text-base font-bold text-blue-600">{aggKec.capaian.toLocaleString('id-ID')}</p>
                  </div>
                </div>
                <div className="border rounded p-2">
                   <p className="text-[10px] md:text-xs text-gray-500 font-semibold flex justify-between">
                     <span>PERSENTASE</span>
                     <span className={`text-sm md:text-base font-bold ${isHeuristic ? getStatusColor(aggKec.persentase).text : (aggKec.persentase >= 50 ? 'text-green-500' : 'text-red-500')}`}>
                       {aggKec.persentase.toFixed(1)}%
                     </span>
                   </p>
                   <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
                      <div className={`h-1.5 rounded-full ${isHeuristic ? getStatusColor(aggKec.persentase).bar : (aggKec.persentase >= 50 ? 'bg-green-500' : 'bg-red-500')}`} style={{ width: `${Math.min(aggKec.persentase, 100)}%` }}></div>
                   </div>
                </div>

                {renderStatusBreakdown(aggKec)}
              </div>

              <div className="p-3 md:p-4 pb-8">
                <button onClick={handleResetToCity} className="w-full bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 py-2 rounded-md font-semibold transition mb-3 text-xs md:text-sm shadow-sm">
                  &larr; Kembali ke Peta Kota
                </button>

                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm md:text-base font-bold text-gray-800">Pilih Kelurahan ({validKelurahanNames.length})</h2>
                  {isHeuristic && (
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as any)}
                      className="text-[11px] bg-white border border-gray-300 rounded-md px-2 py-1 text-gray-700 font-semibold focus:outline-none focus:border-blue-500"
                    >
                      <option value="menunggak">⚠️ Menunggak Terbanyak</option>
                      <option value="asc">Capaian Terendah</option>
                      <option value="desc">Capaian Tertinggi</option>
                      <option value="alpha">Abjad (A-Z)</option>
                    </select>
                  )}
                </div>

                <div className="space-y-2">
                  {validKelurahanNames.length > 0 ? (
                    validKelurahanNames.map((kel, idx) => {
                      const stat = getAggregate('kelurahan', kel, selectedKecamatan);
                      const statusColor = getStatusColor(stat.persentase);
                      return (
                        <button 
                          key={idx} 
                          onClick={() => {
                            const feature = findKelurahanFeature(kel);
                            const bounds = getBoundsArray(feature);
                            handleSelectKelurahanFromSidebar(kel, bounds, feature);
                          }} 
                          className="w-full text-left bg-white shadow-sm hover:bg-emerald-50 border border-gray-200 p-2.5 md:p-3 rounded-lg transition"
                        >
                          <div className="flex justify-between items-center">
                            <span className="text-xs md:text-sm font-semibold text-gray-800">
                              Kel. {kel}
                            </span>
                            {isHeuristic && (
                              <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${statusColor.bgBadge}`}>
                                {stat.persentase.toFixed(1)}%
                              </span>
                            )}
                          </div>
                          {isHeuristic && (
                            <div className="mt-1.5">
                              <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                                <span>Akuisisi: <b>{stat.capaian.toLocaleString('id-ID')}</b> / {stat.target.toLocaleString('id-ID')}</span>
                                <span>{stat.jmlLingkungan} Kepling</span>
                              </div>
                              <div className="w-full bg-gray-100 rounded-full h-1.5 mb-2">
                                <div className={`h-1.5 rounded-full ${statusColor.bar}`} style={{ width: `${Math.min(stat.persentase, 100)}%` }}></div>
                              </div>
                              <div className="flex gap-1.5 text-[10px] font-semibold">
                                <span className="bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200">
                                  🟢 Aktif: {stat.aktif}
                                </span>
                                <span className="bg-amber-50 text-amber-800 px-1.5 py-0.5 rounded border border-amber-200">
                                  🟡 Menunggak: {stat.menunggak}
                                </span>
                                <span className="bg-red-50 text-red-700 px-1.5 py-0.5 rounded border border-red-200">
                                  🔴 {stat.tidakAktif}
                                </span>
                              </div>
                            </div>
                          )}
                        </button>
                      );
                    })
                  ) : (
                    <p className="text-center text-gray-400 text-xs py-4">Memuat data kelurahan...</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ================= LEVEL 3: LINGKUNGAN / KEPLING ================= */}
          {level === 'kepling' && (
            <div className="animate-fadeIn">
              <div className="bg-white p-3 md:p-4 border-b border-gray-200 shadow-sm">
                <p className="text-[10px] md:text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Agregat Kel. {selectedKelurahan}</p>
                <div className="flex gap-1 md:gap-2 mb-2">
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TARGET ({aggKel.jmlLingkungan} KEPLING)</p>
                    <p className="text-sm md:text-base font-bold text-gray-800">{aggKel.target.toLocaleString('id-ID')}</p>
                  </div>
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">CAPAIAN</p>
                    <p className="text-sm md:text-base font-bold text-blue-600">{aggKel.capaian.toLocaleString('id-ID')}</p>
                  </div>
                </div>
                <div className="border rounded p-2">
                   <p className="text-[10px] md:text-xs text-gray-500 font-semibold flex justify-between">
                     <span>PERSENTASE</span>
                     <span className={`text-sm md:text-base font-bold ${isHeuristic ? getStatusColor(aggKel.persentase).text : (aggKel.persentase >= 50 ? 'text-green-500' : 'text-red-500')}`}>
                        {aggKel.persentase.toFixed(1)}%
                     </span>
                   </p>
                   <div className="w-full bg-gray-200 rounded-full h-1.5 mt-1">
                      <div className={`h-1.5 rounded-full ${isHeuristic ? getStatusColor(aggKel.persentase).bar : (aggKel.persentase >= 50 ? 'bg-green-500' : 'bg-red-500')}`} style={{ width: `${Math.min(aggKel.persentase, 100)}%` }}></div>
                   </div>
                </div>

                {renderStatusBreakdown(aggKel)}
              </div>

              <div className="p-3 md:p-4 pb-8">
                <button onClick={handleBackToKecamatan} className="w-full bg-white border border-gray-200 shadow-sm hover:bg-gray-100 text-gray-700 py-2 rounded-md font-semibold transition mb-3 text-xs md:text-sm">
                  &larr; Kembali ke Daftar Kelurahan
                </button>
                <div className="flex items-center justify-between border-b pb-2 mb-3">
                  <h3 className="text-sm font-bold text-gray-700">Daftar Kepling ({sortedKeplingData.length})</h3>
                  {isHeuristic && (
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as any)}
                      className="text-[11px] bg-white border border-gray-300 rounded-md px-2 py-1 text-gray-700 font-semibold"
                    >
                      <option value="menunggak">⚠️ Menunggak Terbanyak</option>
                      <option value="asc">Capaian Terendah</option>
                      <option value="desc">Capaian Tertinggi</option>
                      <option value="alpha">No. Lingkungan (I-XXX)</option>
                    </select>
                  )}
                </div>
                
                <div className="space-y-2 md:space-y-3">
                  {sortedKeplingData.map(kep => {
                    const statusColor = getStatusColor(kep.persentase);
                    return (
                      <div 
                        key={kep.id} 
                        onClick={() => {
                          const marker = markerRefs.current[kep.id];
                          if (marker) marker.openPopup();
                          if (isMobile) setSheetHeight(15);
                        }}
                        className="bg-white border border-gray-200 rounded-lg p-2.5 md:p-3 shadow-sm hover:shadow-md hover:border-blue-400 hover:ring-1 hover:ring-blue-400 transition cursor-pointer"
                      >
                        <div className="flex justify-between items-center mb-0.5">
                          <span className="text-xs md:text-sm font-bold text-gray-800">{kep.name}</span>
                          <span className={`text-[10px] md:text-xs font-bold px-2 py-0.5 rounded border ${isHeuristic ? statusColor.bgBadge : (kep.persentase >= 50 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700')}`}>
                            {kep.persentase.toFixed(1)}%
                          </span>
                        </div>
                        {isHeuristic && (
                          <p className="text-[10px] font-mono text-blue-600 mb-1">
                            Kepling: {kep.kodeKepling}
                          </p>
                        )}
                        <div className="text-[10px] md:text-xs text-gray-500 flex gap-3 mb-1.5">
                           <span>Realisasi: <b>{kep.capaian}</b></span>
                           <span>Target: {kep.target}</span>
                        </div>
                        {isHeuristic && (
                          <div className="flex gap-1.5 text-[10px] font-semibold pt-1 border-t border-gray-100">
                            <span className="text-emerald-700">🟢 Aktif: {kep.aktif}</span>
                            <span className="text-gray-300">|</span>
                            <span className="text-amber-700 font-bold">🟡 Menunggak: {kep.menunggak}</span>
                            <span className="text-gray-300">|</span>
                            <span className="text-red-600">🔴 Non-Aktif: {kep.tidakAktif}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* --- H10: MODAL PANDUAN PENGGUNA --- */}
      {showHelpModal && (
        <div className="fixed inset-0 z-[2000] bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl border border-gray-200 animate-fadeIn">
            <div className="flex justify-between items-center border-b pb-3 mb-3">
              <h2 className="text-base font-bold text-gray-800">📖 Panduan Staf Pembina & Kepling</h2>
              <button onClick={() => setShowHelpModal(false)} className="text-gray-400 hover:text-red-500 font-bold text-lg">✕</button>
            </div>
            <div className="space-y-3 text-xs text-gray-600 leading-relaxed">
              <div>
                <p className="font-bold text-gray-800 mb-0.5">1. Pemantauan Wilayah Binaan (Staf Pembina)</p>
                <p>Gunakan fitur urutkan <b>&ldquo;⚠️ Menunggak Terbanyak&rdquo;</b> atau <b>&ldquo;Capaian Terendah&rdquo;</b> di panel kanan untuk menemukan Kecamatan, Kelurahan, atau Lingkungan yang membutuhkan prioritas pembinaan.</p>
              </div>
              <div>
                <p className="font-bold text-gray-800 mb-0.5">2. Pemantauan Status Warga (Kepala Lingkungan)</p>
                <p>Klik Lingkungan Anda (berdasarkan nomor Romawi I–XXX) untuk membuka daftar warga dan gunakan penyaring status:</p>
                <ul className="list-disc pl-4 mt-1 space-y-0.5">
                  <li><b className="text-emerald-700">🟢 Aktif:</b> Kepesertaan warga aktif dan iuran berjalan lancar.</li>
                  <li><b className="text-amber-700">🟡 Menunggak:</b> Warga terlambat membayar iuran (prioritas pengingat/penagihan).</li>
                  <li><b className="text-red-600">🔴 Tidak Aktif:</b> Kepesertaan warga sudah berhenti/non-aktif.</li>
                </ul>
              </div>
              <div>
                <p className="font-bold text-gray-800 mb-0.5">3. Verifikasi Cepat NIK / Nama Warga</p>
                <p>Ketik minimal 3 karakter Nama atau NIK warga pada kolom pencarian di kanan atas untuk melihat lokasi lingkungan beserta status aktif/menunggak warga tersebut.</p>
              </div>
            </div>
            <button
              onClick={() => setShowHelpModal(false)}
              className="mt-5 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs py-2.5 rounded-lg transition"
            >
              Mengerti & Tutup Panduan
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default Map;