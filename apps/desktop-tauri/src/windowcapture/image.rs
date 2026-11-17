//! Pixels to the PNG the model receives: BGRA/RGBA conversion, a long-edge cap, PNG encoding.

/// The long edge of what leaves the machine. A window can be 4K; the model does not need it.
pub const MAX_EDGE: u32 = 1568;

/// Raw pixels, 4 bytes each, top row first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raw {
    pub width: u32,
    pub height: u32,
    /// `true` when bytes are B,G,R,A (X11, Windows, macOS); `false` for R,G,B,A.
    pub bgra: bool,
    pub data: Vec<u8>,
}

/// Size after capping the long edge at `MAX_EDGE`, keeping the ratio.
pub fn capped_size(width: u32, height: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= MAX_EDGE {
        return (width, height);
    }
    let scale = MAX_EDGE as f64 / long as f64;
    (((width as f64 * scale).round() as u32).max(1), ((height as f64 * scale).round() as u32).max(1))
}

/// Encodes `raw` as an opaque RGB PNG, downscaled (box filter) to the cap. `None` for an empty or inconsistent buffer.
pub fn encode_png(raw: &Raw) -> Option<(Vec<u8>, u32, u32)> {
    let (w, h) = (raw.width as usize, raw.height as usize);
    if w == 0 || h == 0 || raw.data.len() < w * h * 4 {
        return None;
    }
    let (ow, oh) = capped_size(raw.width, raw.height);
    let (ow, oh) = (ow as usize, oh as usize);
    let mut rgb = Vec::with_capacity(ow * oh * 3);
    for oy in 0..oh {
        let (y0, y1) = (oy * h / oh, ((oy + 1) * h / oh).max(oy * h / oh + 1).min(h));
        for ox in 0..ow {
            let (x0, x1) = (ox * w / ow, ((ox + 1) * w / ow).max(ox * w / ow + 1).min(w));
            let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = (y * w + x) * 4;
                    let (c0, c1, c2) = (raw.data[p] as u64, raw.data[p + 1] as u64, raw.data[p + 2] as u64);
                    if raw.bgra { (r, g, b) = (r + c2, g + c1, b + c0) } else { (r, g, b) = (r + c0, g + c1, b + c2) }
                    n += 1;
                }
            }
            rgb.extend_from_slice(&[(r / n) as u8, (g / n) as u8, (b / n) as u8]);
        }
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, ow as u32, oh as u32);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgb).ok()?;
    }
    Some((out, ow as u32, oh as u32))
}

#[cfg(test)]
#[path = "image_tests.rs"]
mod tests;
