use std::env;
use std::error::Error;
use std::fs::File;
use std::io::{self, BufWriter, Read as IoRead, Write};
use std::path::PathBuf;

use calamine::{DataRef, Reader, SheetVisible, Xlsx, open_workbook};
use serde::Serialize;
use zip::ZipArchive;

const MAX_COLUMNS: usize = 1_024;
const ROWS_PER_BATCH: usize = 256;
const TARGET_BATCH_BYTES: usize = 512 * 1_024;
const MAX_PROTOCOL_LINE_BYTES: usize = 8 * 1_024 * 1_024;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Debug)]
struct Options {
    input: PathBuf,
    max_cell_chars: usize,
    max_sheets: usize,
    max_uncompressed_bytes: u64,
    max_zip_entries: usize,
    max_compression_ratio: u64,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Event<'a> {
    Sheet {
        #[serde(rename = "sheetIndex")]
        sheet_index: usize,
        name: &'a str,
        hidden: bool,
    },
    Rows {
        #[serde(rename = "sheetIndex")]
        sheet_index: usize,
        rows: &'a [(u32, Vec<String>)],
    },
    EndSheet {
        #[serde(rename = "sheetIndex")]
        sheet_index: usize,
    },
    Complete {
        #[serde(rename = "sheetCount")]
        sheet_count: usize,
    },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Calamine XLSX reader failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let options = parse_options()?;
    validate_archive(&options)?;
    let mut workbook: Xlsx<_> = open_workbook(&options.input)?;
    let sheets = workbook.sheets_metadata().to_vec();
    if sheets.len() > options.max_sheets {
        return Err(invalid_data("XLSX sheet limit exceeded."));
    }

    let stdout = io::stdout();
    let mut output = BufWriter::with_capacity(64 * 1_024, stdout.lock());
    for (sheet_index, sheet) in sheets.iter().enumerate() {
        write_event(
            &mut output,
            &Event::Sheet {
                sheet_index,
                name: &sheet.name,
                hidden: sheet.visible != SheetVisible::Visible,
            },
        )?;
        stream_sheet(
            &mut workbook,
            &mut output,
            sheet_index,
            &sheet.name,
            options.max_cell_chars,
        )?;
        write_event(&mut output, &Event::EndSheet { sheet_index })?;
    }
    write_event(
        &mut output,
        &Event::Complete {
            sheet_count: sheets.len(),
        },
    )?;
    output.flush()?;
    Ok(())
}

fn validate_archive(options: &Options) -> Result<()> {
    let mut archive = ZipArchive::new(File::open(&options.input)?)?;
    if archive.len() > options.max_zip_entries {
        return Err(invalid_data("XLSX ZIP resource limit exceeded."));
    }
    let mut total_uncompressed = 0u64;
    let mut buffer = [0u8; 64 * 1_024];
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let compressed_size = entry.compressed_size();
        let declared_size = entry.size();
        let mut entry_uncompressed = 0u64;
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            let read = u64::try_from(read)?;
            entry_uncompressed = entry_uncompressed
                .checked_add(read)
                .ok_or_else(|| invalid_data("XLSX ZIP resource limit exceeded."))?;
            total_uncompressed = total_uncompressed
                .checked_add(read)
                .ok_or_else(|| invalid_data("XLSX ZIP resource limit exceeded."))?;
            if entry_uncompressed > options.max_uncompressed_bytes
                || total_uncompressed > options.max_uncompressed_bytes
            {
                return Err(invalid_data("XLSX ZIP resource limit exceeded."));
            }
            if entry_uncompressed > 0
                && (compressed_size == 0
                    || entry_uncompressed
                        > compressed_size.saturating_mul(options.max_compression_ratio))
            {
                return Err(invalid_data("XLSX compression ratio limit exceeded."));
            }
        }
        if entry_uncompressed != declared_size {
            return Err(invalid_data("XLSX ZIP entry size mismatch."));
        }
    }
    Ok(())
}

fn stream_sheet<W: Write>(
    workbook: &mut Xlsx<impl io::Read + io::Seek>,
    output: &mut W,
    sheet_index: usize,
    sheet_name: &str,
    max_cell_chars: usize,
) -> Result<()> {
    let mut reader = workbook.worksheet_cells_reader(sheet_name)?;
    let mut current_row: Option<u32> = None;
    let mut row = Vec::<String>::new();
    let mut batch = Vec::<(u32, Vec<String>)>::with_capacity(ROWS_PER_BATCH);
    let mut estimated_batch_bytes = 0usize;

    while let Some(cell) = reader.next_cell()? {
        let (row_index, column_index) = cell.get_position();
        let row_number = row_index
            .checked_add(1)
            .ok_or_else(|| invalid_data("XLSX row number overflowed."))?;
        let column_index = usize::try_from(column_index)?;
        if column_index >= MAX_COLUMNS {
            return Err(invalid_data("Partition worksheet column limit exceeded."));
        }

        if current_row.is_some_and(|active| active != row_number) {
            let finished_row = current_row.take().expect("active row must exist");
            push_row(
                output,
                sheet_index,
                &mut batch,
                &mut estimated_batch_bytes,
                finished_row,
                std::mem::take(&mut row),
            )?;
        }
        current_row = Some(row_number);
        if row.len() <= column_index {
            row.resize(column_index + 1, String::new());
        }
        let text = cell_text(cell.get_value())?;
        if text.encode_utf16().count() > max_cell_chars {
            return Err(invalid_data("Structured cell length limit exceeded."));
        }
        row[column_index] = text;
    }

    if let Some(row_number) = current_row {
        push_row(
            output,
            sheet_index,
            &mut batch,
            &mut estimated_batch_bytes,
            row_number,
            row,
        )?;
    }
    flush_rows(output, sheet_index, &mut batch)?;
    Ok(())
}

fn push_row<W: Write>(
    output: &mut W,
    sheet_index: usize,
    batch: &mut Vec<(u32, Vec<String>)>,
    estimated_batch_bytes: &mut usize,
    row_number: u32,
    row: Vec<String>,
) -> Result<()> {
    let row_bytes = row.iter().map(String::len).sum::<usize>() + row.len() * 4 + 16;
    if !batch.is_empty()
        && (batch.len() >= ROWS_PER_BATCH
            || estimated_batch_bytes.saturating_add(row_bytes) > TARGET_BATCH_BYTES)
    {
        flush_rows(output, sheet_index, batch)?;
        *estimated_batch_bytes = 0;
    }
    *estimated_batch_bytes = estimated_batch_bytes.saturating_add(row_bytes);
    batch.push((row_number, row));
    Ok(())
}

fn flush_rows<W: Write>(
    output: &mut W,
    sheet_index: usize,
    rows: &mut Vec<(u32, Vec<String>)>,
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    write_event(output, &Event::Rows { sheet_index, rows })?;
    rows.clear();
    Ok(())
}

fn write_event<W: Write>(output: &mut W, event: &Event<'_>) -> Result<()> {
    let encoded = serde_json::to_vec(event)?;
    if encoded.len() > MAX_PROTOCOL_LINE_BYTES {
        return Err(invalid_data(
            "Calamine reader protocol row batch exceeded its limit.",
        ));
    }
    output.write_all(&encoded)?;
    output.write_all(b"\n")?;
    Ok(())
}

fn cell_text(value: &DataRef<'_>) -> Result<String> {
    let text = match value {
        DataRef::Int(value) => value.to_string(),
        DataRef::Float(value) if *value == 0.0 => "0".to_owned(),
        DataRef::Float(value) => value.to_string(),
        DataRef::String(value) => value.clone(),
        DataRef::SharedString(value) => (*value).to_owned(),
        DataRef::Bool(value) => value.to_string(),
        DataRef::DateTime(value) => {
            let (year, month, day, hour, minute, second, _) = value.to_ymd_hms_milli();
            if hour == 0 && minute == 0 && second == 0 {
                format!("{year:04}-{month:02}-{day:02}")
            } else {
                format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}")
            }
        }
        DataRef::DateTimeIso(value) | DataRef::DurationIso(value) => value.clone(),
        DataRef::Error(_) => return Err(invalid_data("Unsupported XLSX cell value.")),
        DataRef::Empty => String::new(),
    };
    Ok(text)
}

fn parse_options() -> Result<Options> {
    let mut input = None;
    let mut max_cell_chars = None;
    let mut max_sheets = None;
    let mut max_uncompressed_bytes = None;
    let mut max_zip_entries = None;
    let mut max_compression_ratio = None;
    let mut arguments = env::args().skip(1);
    while let Some(flag) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| invalid_data("Calamine reader option is missing a value."))?;
        match flag.as_str() {
            "--input" => input = Some(PathBuf::from(value)),
            "--max-cell-chars" => max_cell_chars = Some(value.parse::<usize>()?),
            "--max-sheets" => max_sheets = Some(value.parse::<usize>()?),
            "--max-uncompressed-bytes" => max_uncompressed_bytes = Some(value.parse::<u64>()?),
            "--max-zip-entries" => max_zip_entries = Some(value.parse::<usize>()?),
            "--max-compression-ratio" => max_compression_ratio = Some(value.parse::<u64>()?),
            _ => return Err(invalid_data("Unknown Calamine reader option.")),
        }
    }
    let options = Options {
        input: input.ok_or_else(|| invalid_data("Calamine reader input is required."))?,
        max_cell_chars: max_cell_chars
            .ok_or_else(|| invalid_data("Calamine reader cell limit is required."))?,
        max_sheets: max_sheets
            .ok_or_else(|| invalid_data("Calamine reader sheet limit is required."))?,
        max_uncompressed_bytes: max_uncompressed_bytes
            .ok_or_else(|| invalid_data("Calamine reader archive byte limit is required."))?,
        max_zip_entries: max_zip_entries
            .ok_or_else(|| invalid_data("Calamine reader archive entry limit is required."))?,
        max_compression_ratio: max_compression_ratio
            .ok_or_else(|| invalid_data("Calamine reader compression ratio limit is required."))?,
    };
    if options.max_cell_chars == 0
        || options.max_sheets == 0
        || options.max_uncompressed_bytes == 0
        || options.max_zip_entries == 0
        || options.max_compression_ratio == 0
    {
        return Err(invalid_data("Calamine reader limits must be positive."));
    }
    Ok(options)
}

fn invalid_data(message: &'static str) -> Box<dyn Error> {
    Box::new(io::Error::new(io::ErrorKind::InvalidData, message))
}
