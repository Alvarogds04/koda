use super::*;

fn decode(png_bytes: &[u8]) -> (u32, u32, Vec<u8>) {
    let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    (info.width, info.height, buf[..info.buffer_size()].to_vec())
}

#[test]
fn bgra_becomes_rgb_png() {
    let raw = Raw { width: 2, height: 1, bgra: true, data: vec![255, 0, 0, 255, 0, 0, 255, 255] };
    let (png_bytes, w, h) = encode_png(&raw).unwrap();
    assert_eq!((w, h), (2, 1));
    let (dw, dh, pixels) = decode(&png_bytes);
    assert_eq!((dw, dh), (2, 1));
    assert_eq!(pixels, vec![0, 0, 255, 255, 0, 0]); // blue, red
}

#[test]
fn the_long_edge_is_capped_keeping_the_ratio() {
    assert_eq!(capped_size(800, 600), (800, 600));
    assert_eq!(capped_size(3136, 1568), (1568, 784));
    assert_eq!(capped_size(1000, 4704), (333, 1568));
    let raw = Raw { width: 3136, height: 1000, bgra: false, data: vec![9; 3136 * 1000 * 4] };
    let (png_bytes, w, h) = encode_png(&raw).unwrap();
    assert_eq!((w, h), (1568, 500));
    assert_eq!(decode(&png_bytes).0, 1568);
}

#[test]
fn an_empty_or_short_buffer_is_refused() {
    assert!(encode_png(&Raw { width: 0, height: 0, bgra: true, data: vec![] }).is_none());
    assert!(encode_png(&Raw { width: 4, height: 4, bgra: true, data: vec![0; 8] }).is_none());
}
