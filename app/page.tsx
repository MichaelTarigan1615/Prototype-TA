'use client'; // Tambahkan baris ini di paling atas!

import dynamic from 'next/dynamic';

// Mengimpor peta secara dinamis dan mematikan SSR
const MapComponent = dynamic(() => import('../components/Map'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center min-h-screen text-xl font-bold bg-gray-50 text-gray-700">
      Memuat Peta Kota Medan...
    </div>
  )
});

export default function Home() {
  return (
    // Layout layar penuh untuk Command Center
    <main className="w-full h-screen bg-gray-100">
      <MapComponent />
    </main>
  );
}