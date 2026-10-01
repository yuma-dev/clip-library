//! Discord local RPC transport: a Windows named pipe carrying length-prefixed
//! JSON frames. Wire format: LE `u32` opcode, LE `u32` payload length, then
//! that many bytes of UTF-8 JSON. Probes `\\.\pipe\discord-ipc-0` through
//! `-9` and uses the first that connects.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use serde_json::Value;
use tracing::debug;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Pipes::PeekNamedPipe;

/// RPC opcodes (outer frame type, distinct from `cmd` inside a `FRAME` payload).
pub const OP_HANDSHAKE: u32 = 0;
pub const OP_FRAME: u32 = 1;
pub const OP_CLOSE: u32 = 2;
pub const OP_PING: u32 = 3;
pub const OP_PONG: u32 = 4;

/// One decoded inbound message: opcode and parsed JSON body.
pub type Frame = (u32, Value);

/// Live connection to the Discord client. A dedicated thread drains the read
/// half into `frames`; the write half is a mutex-guarded clone so any thread can send.
pub struct Connection {
    writer: Mutex<File>,
    pub frames: Receiver<Frame>,
    /// set on drop: the reader holds its own handle to the pipe, and Discord counts the
    /// connection as open until that one closes too. Leaked readers filled Discord up until it
    /// refused every new connection with 1006 "Server at capacity".
    stop: Arc<AtomicBool>,
}

impl Drop for Connection {
    fn drop(&mut self) {
        // tell Discord we're leaving, as the protocol expects, before the handles close
        let _ = self.send(OP_CLOSE, &serde_json::json!({}));
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Connection {
    /// Probes `discord-ipc-0..9`, errors if none accept (Discord not running).
    pub fn connect() -> Result<Self> {
        for i in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{i}");
            match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(file) => {
                    let reader = file
                        .try_clone()
                        .map_err(|e| anyhow!("clone pipe handle: {e}"))?;
                    let (tx, rx) = crossbeam_channel::unbounded();
                    let stop = Arc::new(AtomicBool::new(false));
                    let reader_stop = Arc::clone(&stop);
                    std::thread::Builder::new()
                        .name("clipdip-discord-rx".into())
                        .spawn(move || read_loop(reader, tx, reader_stop))
                        .map_err(|e| anyhow!("spawn reader: {e}"))?;
                    return Ok(Self {
                        writer: Mutex::new(file),
                        frames: rx,
                        stop,
                    });
                }
                Err(_) => continue,
            }
        }
        Err(anyhow!("no Discord IPC pipe found (is Discord running?)"))
    }

    /// Serializes `payload` to JSON, framed with the opcode + length header.
    pub fn send(&self, op: u32, payload: &Value) -> Result<()> {
        let data = serde_json::to_vec(payload)?;
        // header and body in one write, the way other RPC clients send a frame
        let mut frame = Vec::with_capacity(8 + data.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(data.len() as u32).to_le_bytes());
        frame.extend_from_slice(&data);
        let mut f = self.writer.lock();
        f.write_all(&frame)?;
        f.flush()?;
        Ok(())
    }

    /// RPC `FRAME` shape `{cmd, args, nonce}`; nonce lets the caller match the response.
    pub fn send_command(&self, cmd: &str, args: Value, nonce: &str) -> Result<()> {
        self.send(
            OP_FRAME,
            &serde_json::json!({ "cmd": cmd, "args": args, "nonce": nonce }),
        )
    }

    /// Reply to a `PING` with the same payload as `PONG`, keeps idle connections alive.
    pub fn pong(&self, payload: &Value) -> Result<()> {
        self.send(OP_PONG, payload)
    }
}

/// Never blocks in `ReadFile`: since `try_clone` shares the file object with
/// the writer, a blocking read would deadlock the request/response cycle.
/// `PeekNamedPipe` polls for available bytes instead, sleeping between peeks.
fn read_loop(mut reader: File, tx: Sender<Frame>, stop: Arc<AtomicBool>) {
    let handle = HANDLE(reader.as_raw_handle() as _);
    let mut acc: Vec<u8> = Vec::new();
    loop {
        // the connection was dropped: returning drops our handle, which closes the pipe
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let mut avail: u32 = 0;
        // err means pipe closed/broken
        if unsafe { PeekNamedPipe(handle, None, 0, None, Some(&mut avail), None) }.is_err() {
            break;
        }
        if avail == 0 {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        // data is ready, this read returns without parking
        let mut chunk = vec![0u8; avail as usize];
        match reader.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => acc.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
        // drain every complete frame currently buffered
        loop {
            if acc.len() < 8 {
                break;
            }
            let op = u32::from_le_bytes([acc[0], acc[1], acc[2], acc[3]]);
            let len = u32::from_le_bytes([acc[4], acc[5], acc[6], acc[7]]) as usize;
            if acc.len() < 8 + len {
                break;
            }
            let body = acc[8..8 + len].to_vec();
            acc.drain(0..8 + len);
            let val: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            let preview: String = String::from_utf8_lossy(&body).chars().take(160).collect();
            debug!("discord: <- op={op} len={len} {preview}");
            if tx.send((op, val)).is_err() {
                return; // manager gone
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs Discord running, takes about a minute. A reconnect from the same process gets READY
    /// only after Discord's ~30 s hold; this must still succeed, and dropped connections must
    /// not pile up into 1006 "Server at capacity".
    #[test]
    #[ignore]
    fn reconnects_wait_out_discords_hold() {
        for i in 0..3 {
            let t = std::time::Instant::now();
            let conn = Connection::connect().expect("Discord running");
            crate::handshake(&conn, crate::CLIENT_ID).unwrap_or_else(|e| panic!("round {i}: {e:#}"));
            eprintln!("round {i}: READY after {:?}", t.elapsed());
            drop(conn);
        }
    }
}
