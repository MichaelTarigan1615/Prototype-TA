'use client';

import { useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, GeoJSON, Tooltip, CircleMarker, Popup, useMap } from 'react-leaflet';
import Papa from 'papaparse';
import 'leaflet/dist/leaflet.css';

const medanBounds: [[number, number], [number, number]] = [
  [3.4200, 98.4700], 
  [3.8500, 98.8200]  
];

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

// --- SOLUSI 1: Menambahkan invalidateSize untuk memperbaiki klik yang meleset ---
const MapController = ({ bounds, centerTo, level }: { bounds: any, centerTo: [number, number] | null, level: string }) => {
  const map = useMap();
  useEffect(() => {
    // Memaksa Leaflet melakukan kalibrasi ulang dimensi kanvas setelah animasi CSS selesai
    setTimeout(() => { map.invalidateSize(); }, 300);
    
    if (bounds) {
      map.flyToBounds(bounds, { duration: 1.5, maxZoom: 15 });
    } else if (centerTo) {
      map.flyTo(centerTo, 12, { duration: 1.5 });
    }
  }, [bounds, centerTo, level, map]);
  return null;
};

const Map = () => {
  const defaultPosition: [number, number] = [3.5952, 98.6722];
  
  const [geoDataKecamatan, setGeoDataKecamatan] = useState<any>(null);
  const [geoDataKelurahan, setGeoDataKelurahan] = useState<any>(null);
  
  const [keplingMaster, setKeplingMaster] = useState<any[]>([]); 
  const [keplingAcquisition, setKeplingAcquisition] = useState<Record<string, number>>({}); 
  const [csvData, setCsvData] = useState<any[]>([]); 
  const [totalAkuisisi, setTotalAkuisisi] = useState(0); 
  
  const [listKecamatan, setListKecamatan] = useState<{name: string, bounds: any}[]>([]);
  const [listKelurahan, setListKelurahan] = useState<{name: string, bounds: any, feature: any}[]>([]);

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
    } else {
      document.body.style.userSelect = '';
    }

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
    fetch('/geojson/kecamatan_medan.geojson')
      .then((res) => res.json())
      .then((data) => setGeoDataKecamatan(data));

    fetch('/geojson/kelurahan_medan.geojson')
      .then((res) => res.json())
      .then((data) => setGeoDataKelurahan(data));

    Papa.parse('/ALL KEPLING.csv', {
      download: true, header: true, delimiter: ';',
      complete: (results) => setKeplingMaster(results.data)
    });

    Papa.parse('/DATA_DUMMY_TK.csv', {
      download: true, header: true, delimiter: ',',
      complete: (results) => {
        const counts: Record<string, number> = {};
        let total = 0;
        results.data.forEach((row: any) => {
          if (row.Wilayah) {
            counts[row.Wilayah] = (counts[row.Wilayah] || 0) + 1;
            total++;
          }
        });
        setKeplingAcquisition(counts);
        setTotalAkuisisi(total);
        setCsvData(results.data); 
      }
    });
  }, []);

  const getAggregate = (type: 'kota' | 'kecamatan' | 'kelurahan', name?: string) => {
    let tTarget = 0; let tCapaian = 0;
    let filtered = keplingMaster;
    if (type === 'kecamatan' && name) filtered = keplingMaster.filter(k => k.Kecamatan && k.Kecamatan.toUpperCase() === name.toUpperCase());
    else if (type === 'kelurahan' && name) filtered = keplingMaster.filter(k => k.Kelurahan && k.Kelurahan.toUpperCase() === name.toUpperCase());

    filtered.forEach(k => {
      const key = `${k.Kecamatan}-${k.Kelurahan}-${k.Nomor}`;
      tTarget += 50; tCapaian += (keplingAcquisition[key] || 0);
    });
    return { target: tTarget, capaian: tCapaian, persentase: tTarget > 0 ? (tCapaian / tTarget) * 100 : 0 };
  };

  const aggKota = getAggregate('kota');
  const aggKec = selectedKecamatan ? getAggregate('kecamatan', selectedKecamatan) : { target: 0, capaian: 0, persentase: 0 };
  const aggKel = selectedKelurahan ? getAggregate('kelurahan', selectedKelurahan) : { target: 0, capaian: 0, persentase: 0 };

  const filterPolygonsOnly = (feature: any) => {
    const isPoly = feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon';
    if (!isPoly) return false;
    if (feature.id && typeof feature.id === 'string' && feature.id.startsWith('way')) return false;
    if (!feature.properties || !feature.properties.name) return false;
    if (feature.geometry.type === 'Polygon' && feature.geometry.coordinates[0].length === 5) return false;
    return true;
  };

  const generateKeplingData = (bounds: any, kelurahanName: string, feature: any) => {
    const realKeplings = keplingMaster.filter((row) => 
      row.Kelurahan && row.Kelurahan.toUpperCase() === kelurahanName.toUpperCase()
    );

    const data: any[] = [];
    const newMemoryUpdates: Record<string, {lat: number, lng: number}> = {};

    realKeplings.forEach((row, i) => {
      const wilayahKey = `${row.Kecamatan}-${row.Kelurahan}-${row.Nomor}`;
      const capaian = keplingAcquisition[wilayahKey] || 0;
      const target = 50; 
      const persentase = (capaian / target) * 100;
      const daftarPeserta = csvData.filter((d: any) => d.Wilayah === wilayahKey);

      let lat = 0, lng = 0;
      if (keplingMemory[wilayahKey]) {
        lat = keplingMemory[wilayahKey].lat;
        lng = keplingMemory[wilayahKey].lng;
      } else {
        let attempts = 0;
        let found = false;
        while (!found && attempts < 1000) {
          attempts++;
          const tLat = bounds.getSouth() + Math.random() * (bounds.getNorth() - bounds.getSouth());
          const tLng = bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest());
          if (isPointInFeature([tLng, tLat], feature)) {
            lat = tLat; lng = tLng; found = true;
          }
        }
        if (found) newMemoryUpdates[wilayahKey] = { lat, lng };
      }

      if (lat && lng) {
        data.push({ id: i + 1, name: `Lingkungan ${row.Nomor}`, lat, lng, target, capaian, persentase, peserta: daftarPeserta });
      }
    });

    if (Object.keys(newMemoryUpdates).length > 0) setKeplingMemory(prev => ({ ...prev, ...newMemoryUpdates }));
    setKeplingData(data.sort((a, b) => a.persentase - b.persentase));
  };

  const validKelurahanNames = selectedKecamatan 
    ? Array.from(new Set(keplingMaster.filter(k => k.Kecamatan && k.Kecamatan.toUpperCase() === selectedKecamatan.toUpperCase()).map(k => k.Kelurahan.toUpperCase())))
    : [];
  
  const displayKelurahans = listKelurahan.filter(kel => validKelurahanNames.includes(kel.name.toUpperCase()));

  const handleSelectKecamatanFromSidebar = (namaKec: string, bounds: any) => {
    setLevel('kelurahan'); setSelectedKecamatan(namaKec);
    setMapBoundsTarget(bounds); setKeplingData([]); 
    if (isMobile) setSheetHeight(45); 
  };

  const handleSelectKelurahanFromSidebar = (namaKel: string, bounds: any, feature: any) => {
    setLevel('kepling'); setSelectedKelurahan(namaKel);
    setMapBoundsTarget(bounds); generateKeplingData(bounds, namaKel, feature); 
    if (isMobile) setSheetHeight(45);
  };

  const handleResetToCity = () => {
    setLevel('kecamatan'); setSelectedKecamatan(null); setSelectedKelurahan(null);
    setMapBoundsTarget(null); setMapCenterTarget(defaultPosition); setKeplingData([]); 
  };

  return (
    <div className="flex flex-col md:flex-row w-full h-[100dvh] relative bg-gray-50 overflow-hidden">
      
      {/* --- AREA PETA --- */}
      <div className="w-full md:w-3/4 h-full relative bg-gray-100 z-0">
        <MapContainer center={defaultPosition} zoom={12} minZoom={11} maxBounds={medanBounds} maxBoundsViscosity={1.0} className="w-full h-full z-0 pb-16 md:pb-0">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          
          {/* Inject MapController with level trigger to fix resize bugs */}
          <MapController bounds={mapBoundsTarget} centerTo={mapCenterTarget} level={level} />

          {geoDataKecamatan && level === 'kecamatan' && (
            <GeoJSON 
              key="layer-kecamatan-bersih"
              data={geoDataKecamatan} filter={filterPolygonsOnly} style={{ fillColor: "#3b82f6", weight: 2, color: 'white', fillOpacity: 0.4 }}
              onEachFeature={(feature, layer) => {
                const namaKec = feature.properties.name || "Kecamatan";
                layer.on('add', (e) => {
                  setListKecamatan((prev) => {
                    if (!prev.find(k => k.name === namaKec)) return [...prev, { name: namaKec, bounds: e.target.getBounds() }].sort((a,b) => a.name.localeCompare(b.name));
                    return prev;
                  });
                });
                layer.bindTooltip(namaKec, { direction: "center", className: "font-bold" });
                
                // --- SOLUSI 2: EFEK HOVER KECAMATAN ---
                layer.on({
                  mouseover: (e) => {
                    const l = e.target;
                    l.setStyle({ fillOpacity: 0.7, weight: 3, color: '#f8fafc' });
                    l.bringToFront(); // Membawa polygon ke depan agar outline tidak terpotong
                  },
                  mouseout: (e) => {
                    const l = e.target;
                    l.setStyle({ fillOpacity: 0.4, weight: 2, color: 'white' });
                  },
                  click: (e) => { 
                    if (typeof e.target.getBounds === 'function') handleSelectKecamatanFromSidebar(namaKec, e.target.getBounds()); 
                  }
                });
              }}
            />
          )}

          {/* --- SOLUSI 3: ISOLASI KELURAHAN (HANYA RENDER KELURAHAN DARI KECAMATAN TERPILIH) --- */}
          {geoDataKelurahan && (level === 'kelurahan' || level === 'kepling') && (
            <GeoJSON 
              // Key yang spesifik memaksa Leaflet menghancurkan kelurahan kecamatan lain
              key={`layer-kelurahan-${selectedKecamatan}-${selectedKelurahan || 'semua'}`}
              data={geoDataKelurahan} 
              filter={(feature: any) => {
                if (!filterPolygonsOnly(feature)) return false;
                // Hanya izinkan render jika kelurahan ini termasuk dalam array Kecamatan yang valid
                const namaKel = (feature.properties.name || "").toUpperCase();
                return validKelurahanNames.includes(namaKel);
              }} 
              style={(feature: any) => {
                const namaKel = feature.properties.name || "Kelurahan";
                const isSelected = selectedKelurahan === namaKel;
                if (level === 'kepling') return { fillColor: isSelected ? "#10b981" : "transparent", weight: isSelected ? 2 : 0, color: isSelected ? '#ffffff' : 'transparent', fillOpacity: isSelected ? 0.6 : 0 };
                return { fillColor: "#38bdf8", weight: 1, color: '#ffffff', fillOpacity: 0.4 };
              }}
              onEachFeature={(feature, layer) => {
                const namaKel = feature.properties.name || "Kelurahan";
                layer.on('add', (e) => {
                  setListKelurahan((prev) => {
                     if (!prev.find(k => k.name === namaKel)) return [...prev, { name: namaKel, bounds: e.target.getBounds(), feature: feature }].sort((a,b) => a.name.localeCompare(b.name));
                     return prev;
                  });
                });
                layer.bindTooltip(`Kel. ${namaKel}`, { direction: "auto" });
                
                // --- SOLUSI 2: EFEK HOVER KELURAHAN ---
                layer.on({
                  mouseover: (e) => {
                    if (levelRef.current === 'kelurahan') {
                      const l = e.target;
                      l.setStyle({ fillOpacity: 0.7, weight: 2, color: '#f8fafc' });
                      l.bringToFront();
                    }
                  },
                  mouseout: (e) => {
                    if (levelRef.current === 'kelurahan') {
                      const l = e.target;
                      l.setStyle({ fillOpacity: 0.4, weight: 1, color: '#ffffff' });
                    }
                  },
                  click: (e) => {
                    if (typeof e.target.getBounds === 'function') handleSelectKelurahanFromSidebar(namaKel, e.target.getBounds(), feature);
                  }
                });
              }}
            />
          )}

          {level === 'kepling' && keplingData.map((kep) => (
            <CircleMarker 
              key={kep.id} center={[kep.lat, kep.lng]} radius={8} color="white" weight={2} fillColor={kep.persentase >= 50 ? '#10b981' : '#ef4444'} fillOpacity={1}
              ref={(ref) => { if (ref) markerRefs.current[kep.id] = ref; }}
              eventHandlers={{ 
                click: (e) => {
                  e.originalEvent.stopPropagation();
                  if (isMobile) setSheetHeight(15); 
                }
              }}
            >
              <Popup autoPan={true}>
                <div className="w-56 font-sans">
                  <h3 className="font-bold text-lg mb-1 text-center text-gray-800">{kep.name}</h3>
                  <hr className="mb-2"/>
                  <div className="flex justify-between text-xs mb-1"><span className="text-gray-600">Target:</span><b>{kep.target}</b></div>
                  <div className="flex justify-between text-xs"><span className="text-gray-600">Capaian:</span><b className="text-blue-600">{kep.capaian}</b></div>
                  <div className={`mt-2 px-2 py-1.5 rounded text-white text-center text-xs font-bold ${kep.persentase >= 50 ? 'bg-green-500' : 'bg-red-500'}`}>
                    {kep.persentase.toFixed(1)}% Terealisasi
                  </div>

                  <div className="mt-3 pt-2 border-t border-gray-200">
                    <p className="text-[10px] font-bold text-gray-500 mb-1">DAFTAR PESERTA ({kep.peserta?.length || 0}):</p>
                    <div className="max-h-36 overflow-y-auto border border-gray-200 rounded bg-gray-50 p-1 custom-scrollbar" onTouchStart={(e) => e.stopPropagation()}>
                      {kep.peserta && kep.peserta.length > 0 ? (
                        kep.peserta.map((p: any, idx: number) => (
                          <div key={idx} className="border-b border-gray-200 last:border-0 py-1.5 px-1 hover:bg-gray-100 transition">
                            <div className="font-bold text-gray-700 text-xs leading-tight">{p['Nama TK']}</div>
                            <div className="text-gray-400 text-[10px] mt-0.5">NIK: {p.NIK}</div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center text-gray-400 text-xs py-3 font-medium">Belum ada peserta</div>
                      )}
                    </div>
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          ))}
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

        <div className="hidden md:block bg-blue-950 text-white p-5 border-b border-blue-800 flex-shrink-0">
          <h1 className="text-xl font-bold leading-tight">Dashboard UCJ 2026</h1>
          <p className="text-blue-300 text-sm mt-1">BPJS Ketenagakerjaan Medan</p>
        </div>

        <div className="md:hidden bg-blue-950 text-white px-5 pb-4 border-b border-blue-800 flex-shrink-0 flex justify-between items-center">
          <div>
            <h1 className="text-lg font-bold leading-tight">Dashboard UCJ</h1>
            <p className="text-blue-300 text-[10px] mt-0.5">BPJS Ketenagakerjaan Medan</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-50 block">
          
          {level === 'kecamatan' && (
            <div className="animate-fadeIn">
              <div className="bg-white p-3 md:p-4 border-b border-gray-200 shadow-sm">
                <p className="text-[10px] md:text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 md:mb-3">Agregat Kota Medan</p>
                <div className="grid grid-cols-3 gap-1 md:gap-2 mb-2 md:mb-3">
                  <div className="border rounded p-1.5 md:p-2 text-center bg-gray-50">
                    <p className="text-[8px] md:text-[10px] text-gray-500 font-semibold">KECAMATAN</p>
                    <p className="text-sm md:text-lg font-bold text-gray-800">21</p>
                  </div>
                  <div className="border rounded p-1.5 md:p-2 text-center bg-gray-50">
                    <p className="text-[8px] md:text-[10px] text-gray-500 font-semibold">KELURAHAN</p>
                    <p className="text-sm md:text-lg font-bold text-gray-800">151</p>
                  </div>
                  <div className="border rounded p-1.5 md:p-2 text-center bg-gray-50">
                    <p className="text-[8px] md:text-[10px] text-gray-500 font-semibold">LINGKUNGAN</p>
                    <p className="text-sm md:text-lg font-bold text-gray-800">2.001</p>
                  </div>
                </div>
                <div className="flex gap-1 md:gap-2 mb-2 md:mb-3">
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TARGET PESERTA</p>
                    <p className="text-sm md:text-lg font-bold text-gray-800">100.050</p>
                  </div>
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TOTAL AKUISISI</p>
                    <p className="text-sm md:text-lg font-bold text-blue-600">{totalAkuisisi.toLocaleString('id-ID')}</p>
                  </div>
                </div>
                <div className="border rounded p-2 md:p-3">
                   <p className="text-[10px] md:text-xs text-gray-500 font-semibold flex justify-between">
                     <span>PERSENTASE</span>
                     <span className={`text-sm md:text-lg font-bold ${((totalAkuisisi / 100050) * 100) >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                       {((totalAkuisisi / 100050) * 100).toFixed(1)}%
                     </span>
                   </p>
                   <div className="w-full bg-gray-200 rounded-full h-1.5 md:h-2 mt-1 md:mt-2">
                      <div className={`h-1.5 md:h-2 rounded-full ${((totalAkuisisi / 100050) * 100) >= 50 ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${Math.min(((totalAkuisisi / 100050) * 100), 100)}%` }}></div>
                   </div>
                </div>
              </div>

              <div className="p-3 md:p-4 pb-8">
                <h2 className="text-sm md:text-lg font-bold text-gray-800 mb-2">Pilih Kecamatan</h2>
                <div className="space-y-2 mt-2">
                  {listKecamatan.map((kec, idx) => (
                    <button key={idx} onClick={() => handleSelectKecamatanFromSidebar(kec.name, kec.bounds)} className="w-full text-left bg-white shadow-sm hover:bg-blue-50 border border-gray-100 p-2.5 md:p-3 rounded-lg text-xs md:text-sm font-semibold text-gray-700 hover:text-blue-700 transition">
                      Kecamatan {kec.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {level === 'kelurahan' && (
            <div className="animate-fadeIn">
              <div className="bg-white p-3 md:p-4 border-b border-gray-200 shadow-sm">
                <p className="text-[10px] md:text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 md:mb-3">Agregat Kec. {selectedKecamatan}</p>
                <div className="flex gap-1 md:gap-2 mb-2 md:mb-3">
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TARGET</p>
                    <p className="text-sm md:text-lg font-bold text-gray-800">{aggKec.target.toLocaleString('id-ID')}</p>
                  </div>
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">CAPAIAN</p>
                    <p className="text-sm md:text-lg font-bold text-blue-600">{aggKec.capaian.toLocaleString('id-ID')}</p>
                  </div>
                </div>
                <div className="border rounded p-2 md:p-3">
                   <p className="text-[10px] md:text-xs text-gray-500 font-semibold flex justify-between">
                     <span>PERSENTASE</span>
                     <span className={`text-sm md:text-lg font-bold ${aggKec.persentase >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                       {aggKec.persentase.toFixed(1)}%
                     </span>
                   </p>
                   <div className="w-full bg-gray-200 rounded-full h-1.5 md:h-2 mt-1 md:mt-2">
                      <div className={`h-1.5 md:h-2 rounded-full ${aggKec.persentase >= 50 ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${Math.min(aggKec.persentase, 100)}%` }}></div>
                   </div>
                </div>
              </div>

              <div className="p-3 md:p-4 pb-8">
                <button onClick={handleResetToCity} className="w-full bg-white border border-gray-200 hover:bg-gray-100 text-gray-700 py-2 rounded-md font-semibold transition mb-3 text-xs md:text-sm shadow-sm">
                  &larr; Kembali ke Peta Kota
                </button>
                <h2 className="text-sm md:text-lg font-bold text-gray-800 mb-2">Pilih Kelurahan</h2>
                <div className="space-y-2">
                  {displayKelurahans.length > 0 ? (
                    displayKelurahans.map((kel, idx) => (
                      <button key={idx} onClick={() => handleSelectKelurahanFromSidebar(kel.name, kel.bounds, kel.feature)} className="w-full text-left bg-white shadow-sm hover:bg-emerald-50 border border-emerald-100 p-2.5 md:p-3 rounded-lg text-xs md:text-sm font-semibold text-emerald-800 transition">
                        Kel. {kel.name}
                      </button>
                    ))
                  ) : (
                    <p className="text-center text-gray-400 text-xs py-4">Memuat data kelurahan...</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {level === 'kepling' && (
            <div className="animate-fadeIn">
              <div className="bg-white p-3 md:p-4 border-b border-gray-200 shadow-sm">
                <p className="text-[10px] md:text-xs font-bold text-gray-500 uppercase tracking-wider mb-2 md:mb-3">Agregat Kel. {selectedKelurahan}</p>
                <div className="flex gap-1 md:gap-2 mb-2 md:mb-3">
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">TARGET</p>
                    <p className="text-sm md:text-lg font-bold text-gray-800">{aggKel.target.toLocaleString('id-ID')}</p>
                  </div>
                  <div className="flex-1 border rounded p-1.5 md:p-2">
                    <p className="text-[9px] md:text-xs text-gray-500 font-semibold">CAPAIAN</p>
                    <p className="text-sm md:text-lg font-bold text-blue-600">{aggKel.capaian.toLocaleString('id-ID')}</p>
                  </div>
                </div>
                <div className="border rounded p-2 md:p-3">
                   <p className="text-[10px] md:text-xs text-gray-500 font-semibold flex justify-between">
                     <span>PERSENTASE</span>
                     <span className={`text-sm md:text-lg font-bold ${aggKel.persentase >= 50 ? 'text-green-500' : 'text-red-500'}`}>
                        {aggKel.persentase.toFixed(1)}%
                     </span>
                   </p>
                   <div className="w-full bg-gray-200 rounded-full h-1.5 md:h-2 mt-1 md:mt-2">
                      <div className={`h-1.5 md:h-2 rounded-full ${aggKel.persentase >= 50 ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${Math.min(aggKel.persentase, 100)}%` }}></div>
                   </div>
                </div>
              </div>

              <div className="p-3 md:p-4 pb-8">
                <button onClick={() => { setLevel('kelurahan'); setKeplingData([]); setSelectedKelurahan(null); }} className="w-full bg-white border border-gray-200 shadow-sm hover:bg-gray-100 text-gray-700 py-2 rounded-md font-semibold transition mb-3 text-xs md:text-sm">
                  &larr; Kembali ke Daftar Kelurahan
                </button>
                <h3 className="text-sm md:text-base font-bold text-gray-700 border-b pb-2 mb-3">Prioritas Tindak Lanjut:</h3>
                
                <div className="space-y-2 md:space-y-3">
                  {keplingData.map(kep => (
                    <div 
                      key={kep.id} 
                      onClick={() => {
                        const marker = markerRefs.current[kep.id];
                        if (marker) marker.openPopup();
                        if (isMobile) setSheetHeight(15);
                      }}
                      className="bg-white border border-gray-200 rounded-lg p-2.5 md:p-3 shadow-sm hover:shadow-md hover:border-blue-400 hover:ring-1 hover:ring-blue-400 transition cursor-pointer"
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-xs md:text-sm font-bold text-gray-800">{kep.name}</span>
                        <span className={`text-[10px] md:text-xs font-bold px-2 py-1 rounded ${kep.persentase >= 50 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{kep.persentase.toFixed(1)}%</span>
                      </div>
                      <div className="text-[10px] md:text-xs text-gray-500 flex justify-between">
                        <span>Capaian: {kep.capaian}</span>
                        <span>Target: {kep.target}</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-1.5 mt-1.5 md:mt-2 overflow-hidden">
                        <div className={`h-full rounded-full ${kep.persentase >= 50 ? 'bg-green-500' : 'bg-red-500'}`} style={{ width: `${kep.persentase}%` }}></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Map;