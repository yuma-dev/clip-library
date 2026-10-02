//! Another process's command line without reading its memory:
//! NtQueryInformationProcess(ProcessCommandLineInformation) only needs
//! PROCESS_QUERY_LIMITED_INFORMATION, same as the exe path lookup.

use windows::Wdk::System::Threading::{NtQueryInformationProcess, PROCESSINFOCLASS};
use windows::Win32::Foundation::{CloseHandle, UNICODE_STRING};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

/// ProcessCommandLineInformation, Windows 8.1+
const PROCESS_COMMAND_LINE_INFORMATION: PROCESSINFOCLASS = PROCESSINFOCLASS(60);

pub fn command_line(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut len = 0u32;
        let _ = NtQueryInformationProcess(
            h,
            PROCESS_COMMAND_LINE_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut len,
        );
        let mut out = None;
        if len as usize > std::mem::size_of::<UNICODE_STRING>() && len < 1 << 20 {
            // u64 backing keeps the UNICODE_STRING header aligned
            let mut buf = vec![0u64; (len as usize).div_ceil(8)];
            let st = NtQueryInformationProcess(
                h,
                PROCESS_COMMAND_LINE_INFORMATION,
                buf.as_mut_ptr().cast(),
                len,
                &mut len,
            );
            if st.is_ok() {
                let us = &*(buf.as_ptr() as *const UNICODE_STRING);
                let chars = us.Length as usize / 2;
                let start = us.Buffer.0 as usize;
                let lo = buf.as_ptr() as usize;
                let hi = lo + buf.len() * 8;
                // the string lives inside our buffer; check before trusting the pointer
                if !us.Buffer.is_null() && start >= lo && start + chars * 2 <= hi {
                    out = Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                        us.Buffer.0,
                        chars,
                    )));
                }
            }
        }
        let _ = CloseHandle(h);
        out
    }
}

/// Splits a command line the way the MSVC runtime does: whitespace
/// separates, quotes group, backslashes only matter before a quote.
pub fn split_args(cmd: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut has_arg = false;
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut n = 1;
                while chars.peek() == Some(&'\\') {
                    chars.next();
                    n += 1;
                }
                if chars.peek() == Some(&'"') {
                    cur.push_str(&"\\".repeat(n / 2));
                    if n % 2 == 1 {
                        chars.next();
                        cur.push('"');
                    }
                } else {
                    cur.push_str(&"\\".repeat(n));
                }
                has_arg = true;
            }
            '"' => {
                in_quotes = !in_quotes;
                has_arg = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_arg {
                    args.push(std::mem::take(&mut cur));
                    has_arg = false;
                }
            }
            c => {
                cur.push(c);
                has_arg = true;
            }
        }
    }
    if has_arg {
        args.push(cur);
    }
    args
}

/// Value after `--name` (or `-name`) or inside `--name=value`.
pub fn arg_value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().map(String::as_str);
        }
        if let Some(v) = a.strip_prefix(name).and_then(|r| r.strip_prefix('=')) {
            return Some(v);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_msvc() {
        let a = split_args(
            r#""C:\Program Files\java.exe" -Xmx2G --gameDir "C:\a b\inst" --x="y z" "" end"#,
        );
        assert_eq!(a[0], r"C:\Program Files\java.exe");
        assert_eq!(arg_value(&a, "--gameDir"), Some(r"C:\a b\inst"));
        assert_eq!(arg_value(&a, "--x"), Some("y z"));
        assert_eq!(a[a.len() - 2], "");
        assert_eq!(a[a.len() - 1], "end");
    }

    #[test]
    fn reads_own_command_line() {
        let cmd = command_line(std::process::id()).unwrap();
        assert!(!cmd.is_empty());
    }
}
