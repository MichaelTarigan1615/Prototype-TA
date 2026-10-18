const fs = require('fs');

// 1. Membaca file master ALL KEPLING.csv
const keplingFile = fs.readFileSync('./public/ALL KEPLING.csv', 'utf8');
const lines = keplingFile.replace(/^\uFEFF/, '').split(/\r?\n/);
lines.shift(); // Membuang baris pertama (Header)

// Fungsi normalisasi agar SEI KERA HILIR I/II & SIDORAME BARAT I/II terpisah rapi (151 Kelurahan)
function normalizeRow(kecRaw, kelRaw, nomorRaw) {
  let kec = (kecRaw || '').trim();
  let kel = (kelRaw || '').trim();
  let nomor = (nomorRaw || '').trim();

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
  return { kec, kel, nomor };
}

// 2. Header CSV baru (menyertakan Kode Kepling dari ALL KEPLING.csv)
let outputCsv = 'No.,Wilayah,Kode_Kepling,NIK,Nama TK,Pekerjaan,Status,Bulan Menunggak\n';
let counter = 1;
let nikSequence = 100001;

const firstNames = [
  'Budi', 'Andi', 'Siti', 'Ayu', 'Rico', 'Zaki', 'Jefri', 'Boy', 'Citra',
  'Michael', 'Putri', 'Sari', 'Agus', 'Hendra', 'Eka', 'Rina', 'Dewi',
  'Joko', 'Fajar', 'Dedi', 'Tono', 'Tini', 'Wati', 'Iwan', 'Rudi',
  'Rahmat', 'Indah', 'Wahyu', 'Lestari', 'Syahrul', 'Nadia', 'Horas'
];

const lastNames = [
  'Siregar', 'Nasution', 'Tarigan', 'Ginting', 'Sembiring', 'Lubis',
  'Harahap', 'Simanjuntak', 'Pasaribu', 'Sitorus', 'Pratama', 'Saputra',
  'Wijaya', 'Kusuma', 'Hidayat', 'Ramadhan', 'Panjaitan', 'Sinaga',
  'Marpaung', 'Saragih', 'Hasibuan', 'Daulay', 'Ritonga', 'Manurung'
];

const jobs = [
  'Pedagang Pasar', 'Pengemudi Ojek', 'Tukang Bangunan', 'Buruh Harian Lepas',
  'Penjahit', 'Montir Bengkel', 'Kurir Logistik', 'Pedagang Kuliner',
  'Juru Parkir', 'Pekerja Kebersihan', 'Supir Angkutan', 'Pengrajin UMKM'
];

// Pengelompokan Kecamatan untuk variasi warna Choropleth Map (Hijau, Kuning, Merah)
const highPerformingKec = [
  'MEDAN BARU', 'MEDAN POLONIA', 'MEDAN KOTA', 'MEDAN PETISAH', 'MEDAN TIMUR'
];
const mediumPerformingKec = [
  'MEDAN JOHOR', 'MEDAN SELAYANG', 'MEDAN SUNGGAL', 'MEDAN HELVETIA',
  'MEDAN AREA', 'MEDAN MAIMUN', 'MEDAN PERJUANGAN', 'MEDAN BARAT'
];

let statSummary = { Aktif: 0, Menunggak: 0, 'Tidak Aktif': 0 };

// 3. Looping ke 2.001 Lingkungan dari ALL KEPLING.csv
for (const line of lines) {
  if (!line.trim()) continue;

  const columns = line.split(';');
  if (columns.length < 5) continue;

  const { kec, kel, nomor } = normalizeRow(columns[1], columns[2], columns[3]);
  const kodeKeplingAsli = columns[4].trim(); // Kolom ke-5: Kepala Lingkungan

  if (!kec || !kel || !nomor) continue;

  // Kunci Wilayah Terstandarisasi: KECAMATAN-KELURAHAN-NOMOR
  const wilayah = `${kec}-${kel}-${nomor}`;
  const kecUpper = kec.toUpperCase();

  let minTK = 4;
  let maxTK = 11; // Kategori Prioritas / Merah (<20%)

  if (highPerformingKec.includes(kecUpper)) {
    minTK = 25;
    maxTK = 38; // Kategori Tercapai / Hijau (>=50%)
  } else if (mediumPerformingKec.includes(kecUpper)) {
    minTK = 11;
    maxTK = 22; // Kategori Sedang / Kuning (20%-49.9%)
  }

  const jumlahTK = Math.floor(Math.random() * (maxTK - minTK + 1)) + minTK;

  for (let i = 0; i < jumlahTK; i++) {
    const nik = `1271002026${String(nikSequence++).padStart(6, '0')}`;
    const fName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const namaLengkap = `${fName} ${lName}`;
    const pekerjaan = jobs[Math.floor(Math.random() * jobs.length)];

    const randStatus = Math.random();
    let status = 'Aktif';
    let bulanMenunggak = 0;

    if (randStatus < 0.68) {
      status = 'Aktif';
    } else if (randStatus < 0.90) {
      status = 'Menunggak';
      bulanMenunggak = Math.floor(Math.random() * 5) + 1;
    } else {
      status = 'Tidak Aktif';
    }

    statSummary[status]++;
    outputCsv += `${counter},${wilayah},${kodeKeplingAsli},${nik},${namaLengkap},${pekerjaan},${status},${bulanMenunggak}\n`;
    counter++;
  }
}

fs.writeFileSync('./public/DATA_DUMMY_TK.csv', outputCsv);

console.log(`✅ SUKSES! Berhasil mencetak ${(counter - 1).toLocaleString('id-ID')} data peserta dari 2.001 Kepling.`);
console.log(`   🟢 Aktif       : ${statSummary['Aktif'].toLocaleString('id-ID')} peserta`);
console.log(`   🟡 Menunggak   : ${statSummary['Menunggak'].toLocaleString('id-ID')} peserta`);
console.log(`   🔴 Tidak Aktif : ${statSummary['Tidak Aktif'].toLocaleString('id-ID')} peserta`);