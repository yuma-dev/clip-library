//! Reader for the Lua table literals Balatro writes to its .jkr files
//! (`return {["key"]=value,[1]=value,}` from the game's STR_PACK, strings via
//! `string.format("%q")`). Only data, never code: anything else is an error.

/// deeper than this is not a save file
const MAX_DEPTH: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Nil,
    Bool(bool),
    Num(f64),
    Str(String),
    Table(Vec<(Key, Value)>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Key {
    Str(String),
    Num(f64),
}

impl Value {
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Table(items) => items.iter().find_map(|(k, v)| match k {
                Key::Str(s) if s == key => Some(v),
                _ => None,
            }),
            _ => None,
        }
    }

    /// `get` along a path of string keys
    pub fn at(&self, path: &[&str]) -> Option<&Value> {
        path.iter().try_fold(self, |v, k| v.get(k))
    }

    pub fn str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

/// Parses a whole file: optional `return`, one value, nothing after it.
pub fn parse(src: &str) -> Option<Value> {
    let mut p = Parser {
        b: src.as_bytes(),
        i: 0,
    };
    p.ws();
    if p.b.get(p.i..)?.starts_with(b"return") {
        p.i += 6;
    }
    let v = p.value(0)?;
    p.ws();
    (p.i == p.b.len()).then_some(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn ws(&mut self) {
        while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) -> bool {
        self.ws();
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn value(&mut self, depth: usize) -> Option<Value> {
        self.ws();
        match self.peek()? {
            b'{' => self.table(depth + 1),
            b'"' | b'\'' => self.string().map(Value::Str),
            _ => {
                let word = self.word()?;
                match word {
                    "nil" => Some(Value::Nil),
                    "true" => Some(Value::Bool(true)),
                    "false" => Some(Value::Bool(false)),
                    w => number(w).map(Value::Num),
                }
            }
        }
    }

    fn table(&mut self, depth: usize) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.i += 1;
        let mut items = Vec::new();
        let mut next_index = 1.0;
        loop {
            if self.eat(b'}') {
                return Some(Value::Table(items));
            }
            self.ws();
            let key = match self.peek()? {
                b'[' => {
                    self.i += 1;
                    let k = match self.value(depth)? {
                        Value::Str(s) => Key::Str(s),
                        Value::Num(n) => Key::Num(n),
                        _ => return None,
                    };
                    if !self.eat(b']') || !self.eat(b'=') {
                        return None;
                    }
                    Some(k)
                }
                c if c.is_ascii_alphabetic() || c == b'_' => {
                    // `name=value`, or a bare true/false/nil list item
                    let start = self.i;
                    let w = self.word()?.to_string();
                    if self.eat(b'=') {
                        Some(Key::Str(w))
                    } else {
                        self.i = start;
                        None
                    }
                }
                _ => None,
            };
            let v = self.value(depth)?;
            let key = key.unwrap_or_else(|| {
                let k = Key::Num(next_index);
                next_index += 1.0;
                k
            });
            items.push((key, v));
            if !self.eat(b',') && !self.eat(b';') {
                return self.eat(b'}').then_some(Value::Table(items));
            }
        }
    }

    fn word(&mut self) -> Option<&str> {
        let start = self.i;
        while self.peek().is_some_and(|c| {
            c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'+' | b'-' | b'#')
        }) {
            self.i += 1;
        }
        std::str::from_utf8(self.b.get(start..self.i)?)
            .ok()
            .filter(|w| !w.is_empty())
    }

    fn string(&mut self) -> Option<String> {
        let quote = self.peek()?;
        self.i += 1;
        let mut out = Vec::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            if c == quote {
                return Some(String::from_utf8_lossy(&out).into_owned());
            }
            if c != b'\\' {
                out.push(c);
                continue;
            }
            let e = self.peek()?;
            self.i += 1;
            match e {
                b'n' | b'\n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'a' => out.push(7),
                b'b' => out.push(8),
                b'f' => out.push(12),
                b'v' => out.push(11),
                // %q writes a carriage return as backslash + CR on some builds
                b'\r' => {
                    out.push(b'\r');
                }
                b'0'..=b'9' => {
                    let mut n = u32::from(e - b'0');
                    for _ in 0..2 {
                        match self.peek() {
                            Some(d @ b'0'..=b'9') => {
                                n = n * 10 + u32::from(d - b'0');
                                self.i += 1;
                            }
                            _ => break,
                        }
                    }
                    out.push(u8::try_from(n).ok()?);
                }
                b'x' => {
                    let hex = std::str::from_utf8(self.b.get(self.i..self.i + 2)?).ok()?;
                    out.push(u8::from_str_radix(hex, 16).ok()?);
                    self.i += 2;
                }
                b'z' => self.ws(),
                other => out.push(other),
            }
        }
    }
}

// tostring() spellings: 1e+20, inf, -nan, and MSVC's 1.#INF / -1.#IND
fn number(w: &str) -> Option<f64> {
    if let Ok(n) = w.parse::<f64>() {
        return Some(n);
    }
    let neg = w.starts_with('-');
    let l = w.to_ascii_lowercase();
    if matches!(l.as_str(), "1.#inf" | "-1.#inf" | "+1.#inf") {
        Some(if neg {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        })
    } else if matches!(
        l.as_str(),
        "1.#ind" | "-1.#ind" | "+1.#ind" | "1.#qnan" | "-1.#qnan" | "1.#snan" | "-1.#snan"
    ) {
        Some(f64::NAN)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn str_pack_output() {
        let v = parse(
            r#"return {["a"]=1,[1]="x",["b"]=true,["outer"]={["inner"]=-4.5,["e"]=1e+20,},}"#,
        )
        .unwrap();
        assert_eq!(v.get("a").and_then(Value::num), Some(1.0));
        assert_eq!(v.get("b").and_then(Value::bool), Some(true));
        assert_eq!(v.at(&["outer", "inner"]).and_then(Value::num), Some(-4.5));
        assert_eq!(v.at(&["outer", "e"]).and_then(Value::num), Some(1e20));
        assert!(
            matches!(&v, Value::Table(items) if items.iter().any(|(k, v)| *k == Key::Num(1.0) && v.str() == Some("x")))
        );
    }

    #[test]
    fn q_escapes() {
        let v = parse(
            "return {[\"quote\"]=\"a\\\"b\\\\c\",[\"nl\"]=\"one\\\ntwo\",[\"z\"]=\"\\000\\65\",}",
        )
        .unwrap();
        assert_eq!(v.get("quote").and_then(Value::str), Some("a\"b\\c"));
        assert_eq!(v.get("nl").and_then(Value::str), Some("one\ntwo"));
        assert_eq!(v.get("z").and_then(Value::str), Some("\0A"));
        // what STR_PACK makes of game objects
        let v = parse(r#"return {["blind"]="\"MANUAL_REPLACE\"",}"#).unwrap();
        assert_eq!(
            v.get("blind").and_then(Value::str),
            Some("\"MANUAL_REPLACE\"")
        );
    }

    #[test]
    fn odd_numbers_and_sloppy_input() {
        let v =
            parse("return {[\"a\"]=inf,[\"b\"]=-1.#IND,[\"c\"]=2.2232954062856e-322,}").unwrap();
        assert_eq!(v.get("a").and_then(Value::num), Some(f64::INFINITY));
        assert!(v.get("b").and_then(Value::num).is_some_and(f64::is_nan));
        assert!(v.get("c").and_then(Value::num).is_some());
        assert_eq!(parse("{}"), Some(Value::Table(vec![])));
        assert_eq!(
            parse("return { a = 1 ; 'x' }").unwrap().get("a"),
            Some(&Value::Num(1.0))
        );
    }

    #[test]
    fn rejects_code_and_junk() {
        for bad in [
            "",
            "return",
            "return {",
            "return {[\"a\"]=}",
            "return {[\"a\"]=os.exit()}",
            "return {} x",
            "return {infinite_code}",
            "return {nan_function}",
            "return {[{}]=1}",
            "\"open",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        let deep = format!("return {}{}", "{".repeat(200), "}".repeat(200));
        assert_eq!(parse(&deep), None);
    }
}
