import {mapCSV, normaliseTracks, parseCSV} from './core.mjs?v=1.0.0';
import {searchKey} from './workflow.mjs?v=1.0.0';

export const columns = {
  title: ['title', 'track', 'song', 'song name', 'track name', 'اسم الأغنية', 'اسم الاغنية', 'الأغنية', 'اغنية'],
  artist: ['artist', 'artists', 'artist name', 'الفنان', 'اسم الفنان'],
  playlist: ['playlist', 'playlist name', 'اللستة', 'القائمة', 'قائمة التشغيل']
};
export function columnIndex(headers, field) {
  const aliases = columns[field].map(searchKey);
  return headers.findIndex(header => aliases.includes(searchKey(header)));
}
function readExcel(buffer) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/assets/sheet-worker.js?v=1.0.0');
    function finish(error, sheets) {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve(sheets);
    }
    const timeout = setTimeout(() => finish('The file took too long to read. Try splitting it into smaller files.'), 15000);
    worker.onerror = () => finish('Could not open the Excel file. Refresh and try again.');
    worker.onmessage = ({data}) => finish(data.error, data.sheets);
    worker.postMessage(buffer, [buffer]);
  });
}
export async function readSheets(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose a file of 10 MB or less.');
  const name = file.name.replace(/\.(csv|xlsx)$/i, '').trim() || 'New playlist';
  if (/\.csv$/i.test(file.name)) return [{name, ...parseCSV(await file.text())}];
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Choose a CSV or XLSX file.');
  const sheets = await readExcel(await file.arrayBuffer());
  return sheets.map(sheet => ({
    name: sheets.length === 1 ? name : sheet.name,
    error: sheet.error,
    headers: sheet.rows?.[0] || [],
    rows: sheet.rows?.slice(1) || []
  }));
}
export function sheetTracks(sheet, name) {
  if (sheet.error) throw new Error(sheet.error);
  const title = columnIndex(sheet.headers, 'title'), artist = columnIndex(sheet.headers, 'artist');
  if (title < 0) throw new Error('Add a Title column in the first row or use the template.');
  const tracks = normaliseTracks(mapCSV(sheet, title, artist, -1, name));
  if (!tracks.length) throw new Error('Add at least one song under the Title column.');
  return tracks;
}
