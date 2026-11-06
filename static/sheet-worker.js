importScripts('/assets/vendor/xlsx-0.20.3.min.js');

self.onmessage = ({data}) => {
  try {
    const workbook = XLSX.read(data, {type: 'array', sheetRows: 20002, cellFormula: false, cellHTML: false});
    if (workbook.SheetNames.length > 40) throw new Error('Split the workbook into files with at most 40 tabs each.');
    const sheets = workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name], ref = sheet?.['!fullref'] || sheet?.['!ref'];
      if (!ref) return {name, rows: []};
      const range = XLSX.utils.decode_range(ref);
      if (range.e.r - range.s.r > 20000 || range.e.c - range.s.c >= 128) {
        return {name, error: 'Each sheet can have up to 20,000 tracks and 128 columns.'};
      }
      const rows = XLSX.utils.sheet_to_json(sheet, {header: 1, blankrows: false, raw: true});
      return {name, rows: rows.map(row => row.map(cell => String(cell ?? ''))) };
    });
    self.postMessage({sheets});
  } catch {
    self.postMessage({error: 'Could not read the file. Open it in Excel, save it as XLSX, and try again.'});
  }
};
