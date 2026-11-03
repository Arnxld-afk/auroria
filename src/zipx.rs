// Minimal zip reader and writers (no zip64), and the PNG decoder/encoder the client skin needs.
use crate::util::*;
use std::fs;
use std::io::{BufWriter, Write};
use std::path::Path;

fn u16le(b: &[u8], o: usize) -> R<usize> { b.get(o..o + 2).map(|x| u16::from_le_bytes([x[0], x[1]]) as usize).ok_or_else(|| Error::new("The archive is damaged.")) }
fn u32le(b: &[u8], o: usize) -> R<usize> { b.get(o..o + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize).ok_or_else(|| Error::new("The archive is damaged.")) }
fn u32be(b: &[u8], o: usize) -> R<usize> { b.get(o..o + 4).map(|x| u32::from_be_bytes([x[0], x[1], x[2], x[3]]) as usize).ok_or_else(|| Error::new("The image is damaged.")) }

pub fn inflate_raw(d: &[u8]) -> R<Vec<u8>> { miniz_oxide::inflate::decompress_to_vec(d).map_err(|_| Error::new("invalid stored block lengths")) }
pub fn deflate_raw(d: &[u8]) -> Vec<u8> { miniz_oxide::deflate::compress_to_vec(d, 6) }
pub fn crc32(d: &[u8]) -> u32 { crc32fast::hash(d) }

pub struct Entry {
    pub name: String,
    method: usize,
    csize: usize,
    lho: usize,
}
impl Entry {
    pub fn read(&self, buf: &[u8]) -> R<Vec<u8>> {
        let start = self.lho + 30 + u16le(buf, self.lho + 26)? + u16le(buf, self.lho + 28)?;
        let d = buf.get(start..(start + self.csize).min(buf.len())).ok_or_else(|| Error::new("The archive is damaged."))?;
        if self.method == 8 { inflate_raw(d) } else { Ok(d.to_vec()) }
    }
    pub fn read_str(&self, buf: &[u8]) -> R<String> { Ok(String::from_utf8_lossy(&self.read(buf)?).into_owned()) }
}
fn find_eocd(buf: &[u8]) -> Option<usize> {
    if buf.len() < 22 { return None; }
    let lo = buf.len().saturating_sub(65557);
    (lo..=buf.len() - 22).rev().find(|&i| buf[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
}
pub fn entries(buf: &[u8]) -> R<Vec<Entry>> {
    let eocd = find_eocd(buf).ok_or_else(|| Error::new("Not a zip archive"))?;
    let count = u16le(buf, eocd + 10)?;
    let mut off = u32le(buf, eocd + 16)?;
    let mut out = Vec::new();
    for _ in 0..count {
        if u32le(buf, off)? != 0x02014b50 { break; }
        let method = u16le(buf, off + 10)?;
        let csize = u32le(buf, off + 20)?;
        let (nlen, elen, clen, lho) = (u16le(buf, off + 28)?, u16le(buf, off + 30)?, u16le(buf, off + 32)?, u32le(buf, off + 42)?);
        let name = String::from_utf8_lossy(buf.get(off + 46..off + 46 + nlen).unwrap_or(&[])).into_owned();
        off += 46 + nlen + elen + clen;
        out.push(Entry { name, method, csize, lho });
    }
    Ok(out)
}
pub fn find<'a>(list: &'a [Entry], name: &str) -> Option<&'a Entry> { list.iter().find(|e| e.name == name) }

/// Unpacks an archive, skipping META-INF and anything under `exclude`.
pub fn extract_zip(file: &Path, dest: &Path, exclude: &[String]) -> R<()> {
    let buf = fs::read(file)?;
    if find_eocd(&buf).is_none() { bail!("{} is not a valid archive.", file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()); }
    for e in entries(&buf)? {
        if e.name.ends_with('/') || e.name.starts_with("META-INF/") || exclude.iter().any(|x| e.name.starts_with(x.as_str())) { continue; }
        if e.method != 8 && e.method != 0 { continue; }
        let Some(target) = resolve_under(dest, &e.name) else { continue };
        let data = e.read(&buf)?;
        if let Some(d) = target.parent() { ensure_dir(d)?; }
        fs::write(&target, data)?;
    }
    Ok(())
}

fn local_header(name: &[u8], crc: u32, csize: usize, size: usize) -> Vec<u8> {
    let mut h = Vec::with_capacity(30 + name.len());
    h.extend_from_slice(&0x04034b50u32.to_le_bytes());
    h.extend_from_slice(&20u16.to_le_bytes());
    h.extend_from_slice(&0x0800u16.to_le_bytes());
    h.extend_from_slice(&8u16.to_le_bytes());
    h.extend_from_slice(&[0, 0, 0, 0]);
    h.extend_from_slice(&crc.to_le_bytes());
    h.extend_from_slice(&(csize as u32).to_le_bytes());
    h.extend_from_slice(&(size as u32).to_le_bytes());
    h.extend_from_slice(&(name.len() as u16).to_le_bytes());
    h.extend_from_slice(&[0, 0]);
    h.extend_from_slice(name);
    h
}
fn central_header(name: &[u8], crc: u32, csize: usize, size: usize, off: usize) -> Vec<u8> {
    let mut h = vec![0u8; 46];
    h[0..4].copy_from_slice(&0x02014b50u32.to_le_bytes());
    h[4..6].copy_from_slice(&20u16.to_le_bytes());
    h[6..8].copy_from_slice(&20u16.to_le_bytes());
    h[8..10].copy_from_slice(&0x0800u16.to_le_bytes());
    h[10..12].copy_from_slice(&8u16.to_le_bytes());
    h[16..20].copy_from_slice(&crc.to_le_bytes());
    h[20..24].copy_from_slice(&(csize as u32).to_le_bytes());
    h[24..28].copy_from_slice(&(size as u32).to_le_bytes());
    h[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
    h[42..46].copy_from_slice(&(off as u32).to_le_bytes());
    h.extend_from_slice(name);
    h
}
fn end_record(count: usize, cd_len: usize, cd_off: usize) -> Vec<u8> {
    let mut e = vec![0u8; 22];
    e[0..4].copy_from_slice(&0x06054b50u32.to_le_bytes());
    e[8..10].copy_from_slice(&(count as u16).to_le_bytes());
    e[10..12].copy_from_slice(&(count as u16).to_le_bytes());
    e[12..16].copy_from_slice(&(cd_len as u32).to_le_bytes());
    e[16..20].copy_from_slice(&(cd_off as u32).to_le_bytes());
    e
}
pub fn write_zip(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let (mut out, mut central) = (Vec::new(), Vec::new());
    for (name, data) in files {
        let comp = deflate_raw(data);
        let crc = crc32(data);
        central.extend(central_header(name.as_bytes(), crc, comp.len(), data.len(), out.len()));
        out.extend(local_header(name.as_bytes(), crc, comp.len(), data.len()));
        out.extend(comp);
    }
    let off = out.len();
    out.extend(end_record(files.len(), central.len(), off));
    let end = out.split_off(off);
    out.extend(central);
    out.extend(end);
    out
}

// Streams a folder into a zip one file at a time, so a large world never sits in memory whole.
pub fn zip_folder(dir: &Path, out_file: &Path, top_level: Option<&[&str]>) -> R<()> {
    let mut part = out_file.as_os_str().to_owned();
    part.push(".part");
    let part = std::path::PathBuf::from(part);
    let res = (|| -> R<()> {
        let mut out = BufWriter::new(fs::File::create(&part)?);
        let (mut central, mut off, mut count) = (Vec::new(), 0usize, 0usize);
        fn walk(dir: &Path, rel: &str, top: Option<&[&str]>, out: &mut BufWriter<fs::File>, central: &mut Vec<u8>, off: &mut usize, count: &mut usize) -> R<()> {
            let here = if rel.is_empty() { dir.to_path_buf() } else { join_rel(dir, rel) };
            for (name, is_dir) in read_dir(&here)? {
                if rel.is_empty() { if let Some(t) = top { if !t.contains(&name.as_str()) { continue; } } }
                let r = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
                if is_dir { walk(dir, &r, top, out, central, off, count)?; continue; }
                if name == "session.lock" { continue; }
                let data = fs::read(join_rel(dir, &r))?;
                let comp = deflate_raw(&data);
                let crc = crc32(&data);
                let lh = local_header(r.as_bytes(), crc, comp.len(), data.len());
                out.write_all(&lh)?;
                out.write_all(&comp)?;
                central.extend(central_header(r.as_bytes(), crc, comp.len(), data.len(), *off));
                *off += lh.len() + comp.len();
                *count += 1;
                if *off > 0xfff00000 || *count > 65000 { bail!("This world is too large to back up as one zip."); }
            }
            Ok(())
        }
        walk(dir, "", top_level, &mut out, &mut central, &mut off, &mut count)?;
        out.write_all(&central)?;
        out.write_all(&end_record(count, central.len(), off))?;
        out.flush()?;
        drop(out);
        fs::rename(&part, out_file)?;
        Ok(())
    })();
    if res.is_err() { rm_force(&part); }
    res
}

// ---------- PNG ----------
pub struct Img {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}
pub fn decode_png(buf: &[u8]) -> Option<Img> {
    if buf.len() < 8 || buf[0..4] != [0x89, 0x50, 0x4e, 0x47] { return None; }
    let (mut off, mut w, mut h, mut bd, mut ct, mut il) = (8usize, 0usize, 0usize, 0u8, 0u8, 0u8);
    let (mut plte, mut trns): (&[u8], &[u8]) = (&[], &[]);
    let mut idat = Vec::new();
    while off + 8 <= buf.len() {
        let len = u32be(buf, off).ok()?;
        let typ = &buf[off + 4..off + 8];
        let data = buf.get(off + 8..off + 8 + len).unwrap_or(&buf[(off + 8).min(buf.len())..]);
        match typ {
            b"IHDR" if data.len() >= 13 => { w = u32be(data, 0).ok()?; h = u32be(data, 4).ok()?; bd = data[8]; ct = data[9]; il = data[12]; }
            b"PLTE" => plte = data,
            b"tRNS" => trns = data,
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        off += 12 + len;
    }
    if bd != 8 || il != 0 || ![2, 3, 6].contains(&ct) { return None; }
    let bpp = if ct == 6 { 4 } else if ct == 2 { 3 } else { 1 };
    let stride = w * bpp;
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib(&idat).ok()?;
    let mut out = vec![0u8; w * h * 4];
    let mut prev = vec![0u8; stride];
    for y in 0..h {
        let row = raw.get(y * (stride + 1)..(y + 1) * (stride + 1))?;
        let f = row[0];
        let mut line = row[1..].to_vec();
        for x in 0..stride {
            let a = if x >= bpp { line[x - bpp] as i32 } else { 0 };
            let b = prev[x] as i32;
            let c = if x >= bpp { prev[x - bpp] as i32 } else { 0 };
            let mut v = line[x] as i32;
            match f {
                1 => v += a,
                2 => v += b,
                3 => v += (a + b) >> 1,
                4 => { let p = a + b - c; let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs()); v += if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c }; }
                _ => {}
            }
            line[x] = (v & 255) as u8;
        }
        for x in 0..w {
            let o = (y * w + x) * 4;
            if ct == 3 {
                let i = line[x] as usize;
                out[o] = *plte.get(i * 3).unwrap_or(&0);
                out[o + 1] = *plte.get(i * 3 + 1).unwrap_or(&0);
                out[o + 2] = *plte.get(i * 3 + 2).unwrap_or(&0);
                out[o + 3] = if i < trns.len() { trns[i] } else { 255 };
            } else {
                out[o] = line[x * bpp];
                out[o + 1] = line[x * bpp + 1];
                out[o + 2] = line[x * bpp + 2];
                out[o + 3] = if bpp == 4 { line[x * bpp + 3] } else { 255 };
            }
        }
        prev = line;
    }
    Some(Img { w, h, data: out })
}
pub fn encode_png(img: &Img) -> Vec<u8> {
    let mut raw = Vec::with_capacity(img.h * (img.w * 4 + 1));
    for y in 0..img.h { raw.push(0); raw.extend_from_slice(&img.data[y * img.w * 4..(y + 1) * img.w * 4]); }
    let chunk = |typ: &[u8], d: &[u8]| -> Vec<u8> {
        let mut c = Vec::with_capacity(d.len() + 12);
        c.extend_from_slice(&(d.len() as u32).to_be_bytes());
        let mut td = typ.to_vec();
        td.extend_from_slice(d);
        c.extend_from_slice(&td);
        c.extend_from_slice(&crc32(&td).to_be_bytes());
        c
    };
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(img.w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(img.h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    let mut out = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    out.extend(chunk(b"IHDR", &ihdr));
    out.extend(chunk(b"IDAT", &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6)));
    out.extend(chunk(b"IEND", &[]));
    out
}
// Shift every saturated colour to the Auroria orange family, keeping light and dark shades.
pub fn recolor(img: &mut Img) -> usize {
    let d = &mut img.data;
    let mut changed = 0;
    let round = |x: f64| (x + 0.5).floor();
    for i in (0..d.len()).step_by(4) {
        if d[i + 3] == 0 { continue; }
        let (r, g, b) = (d[i] as f64 / 255.0, d[i + 1] as f64 / 255.0, d[i + 2] as f64 / 255.0);
        let (max, min) = (r.max(g).max(b), r.min(g).min(b));
        let (l, delta) = ((max + min) / 2.0, max - min);
        if delta < 0.08 { continue; }
        let den = 1.0 - (2.0 * l - 1.0).abs();
        let s = delta / if den == 0.0 { 1.0 } else { den };
        if s < 0.18 { continue; }
        let hh = 26.0 / 360.0;
        let ss = (s * 1.05 + 0.08).min(1.0);
        let q = if l < 0.5 { l * (1.0 + ss) } else { l + ss - l * ss };
        let p = 2.0 * l - q;
        let hue = |t: f64| { let t = (t + 1.0) % 1.0; if t < 1.0 / 6.0 { p + (q - p) * 6.0 * t } else if t < 0.5 { q } else if t < 2.0 / 3.0 { p + (q - p) * (2.0 / 3.0 - t) * 6.0 } else { p } };
        d[i] = round(hue(hh + 1.0 / 3.0) * 255.0).clamp(0.0, 255.0) as u8;
        d[i + 1] = round(hue(hh) * 255.0).clamp(0.0, 255.0) as u8;
        d[i + 2] = round(hue(hh - 1.0 / 3.0) * 255.0).clamp(0.0, 255.0) as u8;
        changed += 1;
    }
    changed
}
/// Nearest-neighbour, keeps aspect, centred on transparent.
pub fn fit_into(src: &Img, w: usize, h: usize) -> Img {
    let mut out = Img { w, h, data: vec![0u8; w * h * 4] };
    let scale = (w as f64 / src.w as f64).min(h as f64 / src.h as f64);
    let round = |x: f64| (x + 0.5).floor();
    let dw = (round(src.w as f64 * scale) as usize).max(1);
    let dh = (round(src.h as f64 * scale) as usize).max(1);
    let ox = ((w as f64 - dw as f64) / 2.0).floor() as isize;
    let oy = ((h as f64 - dh as f64) / 2.0).floor() as isize;
    for y in 0..dh {
        for x in 0..dw {
            let sx = ((x as f64 / scale).floor() as usize).min(src.w - 1);
            let sy = ((y as f64 / scale).floor() as usize).min(src.h - 1);
            let (tx, ty) = (ox + x as isize, oy + y as isize);
            if tx < 0 || ty < 0 || tx as usize >= w || ty as usize >= h { continue; }
            let o = (ty as usize * w + tx as usize) * 4;
            let s = (sy * src.w + sx) * 4;
            out.data[o..o + 4].copy_from_slice(&src.data[s..s + 4]);
        }
    }
    out
}
pub fn crop_alpha(img: Img) -> Img {
    let (mut x0, mut y0, mut x1, mut y1) = (img.w as isize, img.h as isize, -1isize, -1isize);
    for y in 0..img.h {
        for x in 0..img.w {
            if img.data[(y * img.w + x) * 4 + 3] != 0 {
                let (x, y) = (x as isize, y as isize);
                x0 = x0.min(x); y0 = y0.min(y); x1 = x1.max(x); y1 = y1.max(y);
            }
        }
    }
    if x1 < 0 { return img; }
    let (w, h) = ((x1 - x0 + 1) as usize, (y1 - y0 + 1) as usize);
    let mut data = vec![0u8; w * h * 4];
    for y in 0..h {
        let s = ((y0 as usize + y) * img.w + x0 as usize) * 4;
        data[y * w * 4..(y + 1) * w * 4].copy_from_slice(&img.data[s..s + w * 4]);
    }
    Img { w, h, data }
}
