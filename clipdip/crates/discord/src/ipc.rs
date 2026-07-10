//! Discord local RPC transport: a Windows named pipe carrying
//! length-prefixed JSON frames.
//!
//! Wire format per message: a little-endian `u32` opcode, a little-endian
//! `u32` payload length, then that many bytes of UTF-8 JSON. Discord
//! listens on `\\.\pipe\discord-ipc-0` through `-9` (multiple clients /
//! multiple Discord installs each take a slot); we probe them in order and
//! use the first that accepts a connection.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::windows::io::AsRawHandle;
use std::time::Duration;

use anyhow::{anyhow, Result};
use crossbeam_channel::{Receiver, Sender};
use parking_lot::Mutex;
use serde_json::Value;
use tracing::debug;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Pipes::PeekNamedPipe;

/// RPC opcodes (the outer frame type, distinct from the `cmd` inside a
/// `FRAME` payload).
pub const OP_HANDSHAKE: u32 = 0;
pub const OP_FRAME: u32 = 1;
pub const OP_CLOSE: u32 = 2;
pub const OP_PING: u32 = 3;
pub const OP_PONG: u32 = 4;

/// One decoded inbound message: its opcode and parsed JSON body.
pub type Frame = (u32, Value);

/// A live connection to the Discord client. The read half is drained by a
/// dedicated thread (blocking `read_exact`) that pushes decoded frames into
/// `frames`; the write half is a cloned handle guarded by a mutex so any
/// thread can send without racing the reader.
pub struct Connection {
    writer: Mutex<File>,
    pub frames: Receiver<Frame>,
}

impl Connection {
    /// Probe `discord-ipc-0..9` and connect to the first available pipe.
    /// Returns an error if none accept (Discord not running).
    pub fn connect() -> Result<Self> {
        for i in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{i}");
            match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(file) => {
                    let reader = file
                        .try_clone()
                        .map_err(|e| anyhow!("clone pipe handle: {e}"))?;
                    let (tx, rx) = crossbeam_channel::unbounded();
                    std::thread::Builder::new()
                        .name("clipdip-discord-rx".into())
                        .spawn(move || read_loop(reader, tx))
                        .map_err(|e| anyhow!("spawn reader: {e}"))?;
                    return Ok(Self {
                        writer: Mutex::new(file),
                        frames: rx,
                    });
                }
                Err(_) => continue,
            }
        }
        Err(anyhow!("no Discord IPC pipe found (is Discord running?)"))
    }

    /// Send one frame. `payload` is serialized to JSON and framed with the
    /// opcode + length header.
    pub fn send(&self, op: u32, payload: &Value) -> Result<()> {
        let data = serde_json::to_vec(payload)?;
        let mut f = self.writer.lock();
        f.write_all(&op.to_le_bytes())?;
        f.write_all(&(data.len() as u32).to_le_bytes())?;
        f.write_all(&data)?;
        f.flush()?;
        Ok(())
    }

    /// Convenience for the two-step RPC `FRAME` shape:
    /// `{cmd, args, nonce}`. Returns the nonce so the caller can match the
    /// response.
    pub fn send_command(&self, cmd: &str, args: Value, nonce: &str) -> Result<()> {
        self.send(
            OP_FRAME,
            &serde_json::json!({ "cmd": cmd, "args": args, "nonce": nonce }),
        )
    }

    /// Reply to a `PING` with the same payload as a `PONG`, keeping a
    /// long-lived idle connection alive.
    pub fn pong(&self, payload: &Value) -> Result<()> {
        self.send(OP_PONG, payload)
    }
}

/// Reader loop that never parks in a blocking `ReadFile`.
///
/// A blocking read on a synchronous pipe file object holds the file
/// object's I/O lock for as long as it waits — which, since `try_clone`
/// shares that file object with the writer, would block every concurrent
/// write and deadlock the request/response cycle. So instead we
/// `PeekNamedPipe` to see how many bytes are queued and only `ReadFile`
/// when there's actually data (which then returns immediately, never
/// parking). Between peeks we sleep briefly. Exits (dropping the sender,
/// seen by the manager as a disconnect) when the pipe breaks.
fn read_loop(mut reader: File, tx: Sender<Frame>) {
    let handle = HANDLE(reader.as_raw_handle() as _);
    let mut acc: Vec<u8> = Vec::new();
    loop {
        let mut avail: u32 = 0;
        // Err ⇒ pipe closed/broken.
        if unsafe { PeekNamedPipe(handle, None, 0, None, Some(&mut avail), None) }.is_err() {
            break;
        }
        if avail == 0 {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        // Data is ready, so this read returns without parking.
        let mut chunk = vec![0u8; avail as usize];
        match reader.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => acc.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
        // Drain every complete frame currently buffered.
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
