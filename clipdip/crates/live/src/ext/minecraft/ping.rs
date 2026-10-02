//! Server List Ping for the player count. Ported from craftping's sync
//! implementation (kiwiyou, MIT): src/lib.rs + src/sync.rs. Modern ping first,
//! the pre-1.7 0xFE ping on a fresh connection when that fails.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(4);
/// whole ping incl. DNS, which std can't time out on its own
const TOTAL_TIMEOUT: Duration = Duration::from_secs(8);
/// status json with a 64x64 favicon is a few KB, anything near this is junk
const MAX_RESPONSE: i32 = 1 << 20;
/// craftping's PROTOCOL_VERSION_NOT_SET
const PROTOCOL_VERSION_NOT_SET: i32 = -1;

const LAST_SEVEN_BITS: i32 = 0b0111_1111;
const NEXT_BYTE_EXISTS: u8 = 0b1000_0000;
const SEVEN_BITS_SHIFT_MASK: i32 = 0x01_ff_ff_ff;

/// [online, max], None when the server doesn't answer in time. Runs on its
/// own thread so a stuck DNS lookup can't hold up the tick.
pub fn players(host: &str, port: u16) -> Option<[u32; 2]> {
    let (tx, rx) = mpsc::channel();
    let host = host.to_string();
    std::thread::Builder::new()
        .name("mc-ping".into())
        .spawn(move || {
            let _ = tx.send(ping(&host, port));
        })
        .ok()?;
    rx.recv_timeout(TOTAL_TIMEOUT).ok().flatten()
}

fn connect(host: &str, port: u16) -> Option<TcpStream> {
    let addr = (host, port).to_socket_addrs().ok()?.next()?;
    let s = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    s.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    s.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    Some(s)
}

fn ping(host: &str, port: u16) -> Option<[u32; 2]> {
    let mut s = connect(host, port)?;
    if let Some(p) = ping_latest(&mut s, host, port) {
        return Some(p);
    }
    drop(s);
    let mut s = connect(host, port)?;
    ping_legacy(&mut s)
}

fn ping_latest<S: Read + Write>(s: &mut S, host: &str, port: u16) -> Option<[u32; 2]> {
    s.write_all(&build_latest_request(host, port, PROTOCOL_VERSION_NOT_SET))
        .ok()?;
    s.flush().ok()?;
    let _length = read_varint(s)?;
    let packet_id = read_varint(s)?;
    let len = read_varint(s)?;
    if packet_id != 0x00 || !(0..=MAX_RESPONSE).contains(&len) {
        return None;
    }
    let mut buf = vec![0; len as usize];
    s.read_exact(&mut buf).ok()?;
    parse_latest(&buf)
}

fn ping_legacy<S: Read + Write>(s: &mut S) -> Option<[u32; 2]> {
    s.write_all(&LEGACY_REQUEST).ok()?;
    s.flush().ok()?;
    let mut buf = Vec::new();
    s.take(64 * 1024).read_to_end(&mut buf).ok()?;
    parse_legacy(&decode_legacy(&buf)?)
}

fn build_latest_request(host: &str, port: u16, protocol_version: i32) -> Vec<u8> {
    let mut packet = vec![0x00];
    write_varint(&mut packet, protocol_version);
    // some proxies route on hostname and port, vanilla ignores them
    write_varint(&mut packet, host.len() as i32);
    packet.extend_from_slice(host.as_bytes());
    packet.extend_from_slice(&[(port >> 8) as u8, (port & 0xff) as u8, 0x01]);
    let mut full = Vec::with_capacity(packet.len() + 8);
    write_varint(&mut full, packet.len() as i32);
    full.append(&mut packet);
    // status request: length 1, packet id 0
    full.extend_from_slice(&[1, 0x00]);
    full
}

fn parse_latest(buf: &[u8]) -> Option<[u32; 2]> {
    let v: serde_json::Value = serde_json::from_slice(buf).ok()?;
    let p = v.get("players")?;
    let online = p.get("online")?.as_u64()?;
    let max = p.get("max")?.as_u64()?;
    Some([
        online.min(u32::MAX as u64) as u32,
        max.min(u32::MAX as u64) as u32,
    ])
}

/// 0xfe 0x01, plugin message 0xfa with an 11 char channel name, then 7 bytes:
/// protocol 0x4a, empty hostname, port 0
const LEGACY_REQUEST: [u8; 35] = [
    0xfe, 0x01, 0xfa, 0x00, 0x0b, // "MC|PingHost" as UTF-16BE
    0x00, 0x4d, 0x00, 0x43, 0x00, 0x7c, 0x00, 0x50, 0x00, 0x69, 0x00, 0x6e, 0x00, 0x67, 0x00, 0x48,
    0x00, 0x6f, 0x00, 0x73, 0x00, 0x74, 7, 0x4a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

fn decode_legacy(buf: &[u8]) -> Option<String> {
    if buf.len() <= 3 || buf.first() != Some(&0xff) {
        return None;
    }
    let utf16be: Vec<u16> = buf
        .get(3..)?
        .chunks_exact(2)
        .map(|c| ((c[0] as u16) << 8) | c[1] as u16)
        .collect();
    String::from_utf16(&utf16be).ok()
}

/// `\u{a7}1\0protocol\0version\0motd\0online\0max`
fn parse_legacy(s: &str) -> Option<[u32; 2]> {
    let mut f = s.split('\0');
    if f.next()? != "\u{a7}1" {
        return None;
    }
    let _protocol = f.next()?;
    let _version = f.next()?;
    let _motd = f.next()?;
    let online = f.next()?.parse().ok()?;
    let max = f.next()?.parse().ok()?;
    Some([online, max])
}

fn write_varint(sink: &mut Vec<u8>, mut value: i32) {
    loop {
        let mut temp = (value & LAST_SEVEN_BITS) as u8;
        // arithmetic shift, mask off the sign bits
        value >>= 7;
        value &= SEVEN_BITS_SHIFT_MASK;
        if value != 0 {
            temp |= NEXT_BYTE_EXISTS;
        }
        sink.push(temp);
        if value == 0 {
            break;
        }
    }
}

fn read_varint(s: &mut impl Read) -> Option<i32> {
    let mut b = [0u8];
    let mut result = 0i32;
    let mut count = 0u32;
    loop {
        s.read_exact(&mut b).ok()?;
        result |= (b[0] as i32 & LAST_SEVEN_BITS).checked_shl(7 * count)?;
        count += 1;
        if count > 5 {
            return None;
        }
        if b[0] & NEXT_BYTE_EXISTS == 0 {
            return Some(result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn varint_roundtrip() {
        for i in [-2147483648, -1, 0, 1, 300, 2147483647] {
            let mut buf = vec![];
            write_varint(&mut buf, i);
            assert_eq!(read_varint(&mut Cursor::new(buf)), Some(i));
        }
    }

    #[test]
    fn handshake_bytes() {
        let r = build_latest_request("a.b", 25565, -1);
        // len, id 0, protocol -1 as 5 byte varint, host len 3, "a.b", port, next state 1, then request
        assert_eq!(r[0] as usize, r.len() - 3);
        assert_eq!(&r[1..7], &[0x00, 0xff, 0xff, 0xff, 0xff, 0x0f]);
        assert_eq!(&r[7..11], &[3, b'a', b'.', b'b']);
        assert_eq!(&r[11..14], &[0x63, 0xdd, 0x01]);
        assert_eq!(&r[14..], &[1, 0]);
    }

    /// Fake server: canned response bytes after the request.
    struct Fake {
        out: Cursor<Vec<u8>>,
    }
    impl Read for Fake {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.out.read(buf)
        }
    }
    impl Write for Fake {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn parses_status_response() {
        let json = br#"{"version":{"name":"1.21.4","protocol":769},"players":{"max":1000,"online":312,"sample":[]},"description":{"text":"hi"}}"#;
        let mut body = vec![0x00];
        write_varint(&mut body, json.len() as i32);
        body.extend_from_slice(json);
        let mut out = vec![];
        write_varint(&mut out, body.len() as i32);
        out.extend(body);
        let mut f = Fake {
            out: Cursor::new(out),
        };
        assert_eq!(ping_latest(&mut f, "x", 25565), Some([312, 1000]));
    }

    #[test]
    fn rejects_huge_length() {
        let mut out = vec![];
        write_varint(&mut out, 10);
        write_varint(&mut out, 0);
        write_varint(&mut out, i32::MAX);
        let mut f = Fake {
            out: Cursor::new(out),
        };
        assert_eq!(ping_latest(&mut f, "x", 25565), None);
    }

    #[test]
    fn parses_legacy() {
        let s = "\u{a7}1\u{0}127\u{0}1.6.4\u{0}A Minecraft Server\u{0}3\u{0}20";
        let mut buf = vec![0xff, 0x00, 0x00];
        for u in s.encode_utf16() {
            buf.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(parse_legacy(&decode_legacy(&buf).unwrap()), Some([3, 20]));
        assert_eq!(decode_legacy(&[0x00, 1, 2, 3]), None);
    }
}
