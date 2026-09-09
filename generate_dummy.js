const fs = require('fs');

// 1. Membaca file master Kepling
const keplingFile = fs.readFileSync('./public/ALL KEPLING.csv', 'utf8');
const lines = keplingFile.split('\n');
lines.shift(); // Membuang baris pertama (Header)

// 2. Menyiapkan variabel pabrik data
let outputCsv = 'No.,Wilayah,NIK,Nama TK\n';
let counter = 1;
let nikCounter = 1000000000000001; // NIK palsu yang mustahil valid, dibuat berurutan

// Nama-nama satu kata acak
const singleNames = ['Budi', 'Andi', 'Siti', 'Ayu', 'Rico', 'Zaki', 'Jefri', 'Boy', 'Citra', 'Michael', 'Putri', 'Sari', 'Agus', 'Hendra', 'Eka', 'Rina', 'Dewi', 'Joko', 'Fajar', 'Dedi', 'Tono', 'Tini', 'Wati', 'Iwan', 'Rudi'];

// 3. Looping ke 2.001 Lingkungan
for (const line of lines) {
    if (!line.trim()) continue; // Abaikan baris kosong

    // Pisahkan berdasarkan titik koma (;) sesuai format CSV milikmu
    const columns = line.split(';');
    if (columns.length < 5) continue;

    const kecamatan = columns[1].trim();
    const kelurahan = columns[2].trim();
    const nomorLingkungan = columns[3].trim();
    
    // Format Wilayah: KECAMATAN-KELURAHAN-LINGKUNGAN
    const wilayah = `${kecamatan}-${kelurahan}-${nomorLingkungan}`;

    // Menghasilkan jumlah pekerja acak per Lingkungan (Misal: 5 sampai 15 orang)
    const jumlahTK = Math.floor(Math.random() * 11) + 5; 

    for (let i = 0; i < jumlahTK; i++) {
        const nik = nikCounter++;
        const nama = singleNames[Math.floor(Math.random() * singleNames.length)];

        outputCsv += `${counter},${wilayah},${nik},${nama}\n`;
        counter++;
    }
}

// 4. Menyimpan hasil pabrik ke file baru
fs.writeFileSync('./public/DATA_DUMMY_TK.csv', outputCsv);
console.log(`✅ SUKSES! Berhasil mencetak ${counter - 1} baris data dummy.`);
console.log(`File tersimpan di: ./public/DATA_DUMMY_TK.csv`);