use std::cell::RefCell;

const OP_EQUAL: u32 = 0;
const OP_DELETE: u32 = 1;
const OP_INSERT: u32 = 2;

const MAX_MYERS_TRACE_D: usize = 3500;

thread_local! {
    static OUTPUT_BUF: RefCell<Vec<u32>> = RefCell::new(Vec::with_capacity(4096));
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, len);
    }
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u32 {
    OUTPUT_BUF.with(|b| b.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    OUTPUT_BUF.with(|b| b.borrow().len())
}

#[inline]
fn fold_ascii(b: u8, ignore_case: bool) -> u8 {
    if ignore_case && b.is_ascii_uppercase() {
        b + 32
    } else {
        b
    }
}

#[inline]
fn trim_ascii_ws(mut s: &[u8]) -> &[u8] {
    while let Some(&first) = s.first() {
        if first.is_ascii_whitespace() {
            s = &s[1..];
        } else {
            break;
        }
    }
    while let Some(&last) = s.last() {
        if last.is_ascii_whitespace() {
            s = &s[..s.len() - 1];
        } else {
            break;
        }
    }
    s
}

#[inline]
fn hash_bytes(bytes: &[u8], ignore_ws: bool, ignore_case: bool) -> u64 {
    let slice = if ignore_ws { trim_ascii_ws(bytes) } else { bytes };
    let mut h: u64 = 0xcbf29ce484222325;
    let mut prev_ws = false;
    for &b in slice {
        if ignore_ws && b.is_ascii_whitespace() {
            if !prev_ws {
                h ^= b' ' as u64;
                h = h.wrapping_mul(0x100000001b3);
                prev_ws = true;
            }
            continue;
        }
        prev_ws = false;
        h ^= fold_ascii(b, ignore_case) as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[inline]
fn bytes_equal(a: &[u8], b: &[u8], ignore_ws: bool, ignore_case: bool) -> bool {
    let sa = if ignore_ws { trim_ascii_ws(a) } else { a };
    let sb = if ignore_ws { trim_ascii_ws(b) } else { b };
    if !ignore_ws {
        if sa.len() != sb.len() {
            return false;
        }
        if !ignore_case {
            return sa == sb;
        }
        for i in 0..sa.len() {
            if fold_ascii(sa[i], true) != fold_ascii(sb[i], true) {
                return false;
            }
        }
        return true;
    }

    let mut i = 0;
    let mut j = 0;
    while i < sa.len() && j < sb.len() {
        let wa = sa[i].is_ascii_whitespace();
        let wb = sb[j].is_ascii_whitespace();
        if wa && wb {
            while i < sa.len() && sa[i].is_ascii_whitespace() {
                i += 1;
            }
            while j < sb.len() && sb[j].is_ascii_whitespace() {
                j += 1;
            }
            continue;
        }
        if wa != wb || fold_ascii(sa[i], ignore_case) != fold_ascii(sb[j], ignore_case) {
            return false;
        }
        i += 1;
        j += 1;
    }
    while i < sa.len() && sa[i].is_ascii_whitespace() {
        i += 1;
    }
    while j < sb.len() && sb[j].is_ascii_whitespace() {
        j += 1;
    }
    i == sa.len() && j == sb.len()
}

fn split_lines(raw: &[u8]) -> Vec<&[u8]> {
    if raw.is_empty() {
        return Vec::new();
    }
    let mut lines = Vec::with_capacity(raw.len() / 32 + 16);
    let mut start = 0;
    let mut i = 0;
    while i < raw.len() {
        let b = raw[i];
        if b == b'\n' || b == b'\r' {
            lines.push(&raw[start..i]);
            if b == b'\r' && i + 1 < raw.len() && raw[i + 1] == b'\n' {
                i += 1;
            }
            start = i + 1;
        }
        i += 1;
    }
    if start < raw.len() {
        lines.push(&raw[start..]);
    }
    lines
}

#[derive(Clone, Copy)]
struct Item<'a> {
    bytes: &'a [u8],
    hash: u64,
    utf16_len: u32,
}

#[inline]
fn items_equal(a: &Item<'_>, b: &Item<'_>, ignore_ws: bool, ignore_case: bool) -> bool {
    a.hash == b.hash && bytes_equal(a.bytes, b.bytes, ignore_ws, ignore_case)
}

#[inline]
fn push_op(ops: &mut Vec<(u32, u32)>, kind: u32, weight: u32) {
    if weight == 0 {
        return;
    }
    if let Some(last) = ops.last_mut() {
        if last.0 == kind {
            last.1 += weight;
            return;
        }
    }
    ops.push((kind, weight));
}

fn myers_diff(
    a: &[Item<'_>],
    b: &[Item<'_>],
    ignore_ws: bool,
    ignore_case: bool,
    ops: &mut Vec<(u32, u32)>,
) {
    let n = a.len();
    let m = b.len();
    if n == 0 && m == 0 {
        return;
    }
    if n == 0 {
        for item in b {
            push_op(ops, OP_INSERT, item.utf16_len);
        }
        return;
    }
    if m == 0 {
        for item in a {
            push_op(ops, OP_DELETE, item.utf16_len);
        }
        return;
    }

    let mut prefix = 0;
    while prefix < n && prefix < m && items_equal(&a[prefix], &b[prefix], ignore_ws, ignore_case) {
        push_op(ops, OP_EQUAL, a[prefix].utf16_len);
        prefix += 1;
    }

    let mut suffix = 0;
    while prefix + suffix < n
        && prefix + suffix < m
        && items_equal(&a[n - 1 - suffix], &b[m - 1 - suffix], ignore_ws, ignore_case)
    {
        suffix += 1;
    }

    let a_mid = &a[prefix..n - suffix];
    let b_mid = &b[prefix..m - suffix];
    let nm = a_mid.len();
    let mm = b_mid.len();

    if nm == 0 {
        for item in b_mid {
            push_op(ops, OP_INSERT, item.utf16_len);
        }
    } else if mm == 0 {
        for item in a_mid {
            push_op(ops, OP_DELETE, item.utf16_len);
        }
    } else {
        myers_core(a_mid, b_mid, ignore_ws, ignore_case, ops);
    }

    for k in 0..suffix {
        push_op(ops, OP_EQUAL, a[n - suffix + k].utf16_len);
    }
}

fn myers_core(
    a: &[Item<'_>],
    b: &[Item<'_>],
    ignore_ws: bool,
    ignore_case: bool,
    ops: &mut Vec<(u32, u32)>,
) {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let max = (n + m) as usize;
    let max_d = max.min(MAX_MYERS_TRACE_D);

    let size = 2 * max_d + 1;
    let offset = max_d as isize;
    let mut v = vec![0isize; size];
    let mut trace: Vec<Vec<isize>> = Vec::with_capacity(max_d.min(256));

    let mut found_d: Option<usize> = None;

    for d in 0..=max_d {
        trace.push(v.clone());
        let d_isize = d as isize;
        let mut k = -d_isize;
        while k <= d_isize {
            let idx = (k + offset) as usize;
            let mut x = if k == -d_isize || (k != d_isize && v[idx - 1] < v[idx + 1]) {
                v[idx + 1]
            } else {
                v[idx - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && items_equal(&a[x as usize], &b[y as usize], ignore_ws, ignore_case) {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x >= n && y >= m {
                found_d = Some(d);
                break;
            }
            k += 2;
        }
        if found_d.is_some() {
            break;
        }
    }

    let Some(final_d) = found_d else {
        // Fallback for extremely large diverging inputs beyond MAX_MYERS_TRACE_D:
        // emit clean block delete + insert without blowing memory or freezing worker.
        for item in a {
            push_op(ops, OP_DELETE, item.utf16_len);
        }
        for item in b {
            push_op(ops, OP_INSERT, item.utf16_len);
        }
        return;
    };

    let mut rev_steps: Vec<(u32, u32)> = Vec::with_capacity(a.len() + b.len());
    let mut x = n;
    let mut y = m;

    for d in (1..=final_d).rev() {
        let prev_v = &trace[d];
        let k = x - y;
        let d_isize = d as isize;
        let idx = (k + offset) as usize;

        let prev_k = if k == -d_isize || (k != d_isize && prev_v[idx - 1] < prev_v[idx + 1]) {
            k + 1
        } else {
            k - 1
        };

        let prev_x = prev_v[(prev_k + offset) as usize];
        let prev_y = prev_x - prev_k;

        while x > prev_x && y > prev_y {
            x -= 1;
            y -= 1;
            push_op(&mut rev_steps, OP_EQUAL, a[x as usize].utf16_len);
        }

        if x == prev_x {
            y -= 1;
            push_op(&mut rev_steps, OP_INSERT, b[y as usize].utf16_len);
        } else {
            x -= 1;
            push_op(&mut rev_steps, OP_DELETE, a[x as usize].utf16_len);
        }
    }

    while x > 0 && y > 0 {
        x -= 1;
        y -= 1;
        push_op(&mut rev_steps, OP_EQUAL, a[x as usize].utf16_len);
    }

    for &(kind, weight) in rev_steps.iter().rev() {
        push_op(ops, kind, weight);
    }
}

#[no_mangle]
pub extern "C" fn compute_diff(
    left_ptr: *const u8,
    left_len: usize,
    right_ptr: *const u8,
    right_len: usize,
    flags: u32,
) -> usize {
    let ignore_ws = (flags & 1) != 0;
    let ignore_case = (flags & 2) != 0;

    let left_bytes = if left_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(left_ptr, left_len) }
    };
    let right_bytes = if right_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(right_ptr, right_len) }
    };

    let left_raw_lines = split_lines(left_bytes);
    let right_raw_lines = split_lines(right_bytes);

    let left_items: Vec<Item<'_>> = left_raw_lines
        .into_iter()
        .map(|bytes| Item {
            bytes,
            hash: hash_bytes(bytes, ignore_ws, ignore_case),
            utf16_len: 1,
        })
        .collect();

    let right_items: Vec<Item<'_>> = right_raw_lines
        .into_iter()
        .map(|bytes| Item {
            bytes,
            hash: hash_bytes(bytes, ignore_ws, ignore_case),
            utf16_len: 1,
        })
        .collect();

    let mut ops: Vec<(u32, u32)> = Vec::with_capacity(256);
    myers_diff(&left_items, &right_items, ignore_ws, ignore_case, &mut ops);

    OUTPUT_BUF.with(|buf_cell| {
        let mut out = buf_cell.borrow_mut();
        out.clear();
        out.reserve(ops.len() * 2);
        for (kind, count) in ops {
            out.push(kind);
            out.push(count);
        }
        out.len()
    })
}

fn tokenize_intraline<'a>(bytes: &'a [u8], char_mode: bool) -> Vec<Item<'a>> {
    let Ok(s) = std::str::from_utf8(bytes) else {
        return Vec::new();
    };
    if s.is_empty() {
        return Vec::new();
    }

    if char_mode {
        let mut items = Vec::with_capacity(s.len());
        for (byte_idx, ch) in s.char_indices() {
            let slice = &bytes[byte_idx..byte_idx + ch.len_utf8()];
            items.push(Item {
                bytes: slice,
                hash: hash_bytes(slice, false, false),
                utf16_len: ch.len_utf16() as u32,
            });
        }
        return items;
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Class {
        Word,
        Space,
        Other,
    }

    let classify = |ch: char| -> Class {
        if ch.is_alphanumeric() || ch == '_' || ch == '$' {
            Class::Word
        } else if ch.is_whitespace() {
            Class::Space
        } else {
            Class::Other
        }
    };

    let mut items = Vec::with_capacity(s.len() / 4 + 4);
    let mut start_byte = 0usize;
    let mut utf16_acc = 0u32;
    let mut cur_class: Option<Class> = None;

    for (byte_idx, ch) in s.char_indices() {
        let cls = classify(ch);
        match cur_class {
            None => {
                cur_class = Some(cls);
                start_byte = byte_idx;
                utf16_acc = ch.len_utf16() as u32;
            }
            Some(prev) if prev == cls && cls != Class::Other => {
                utf16_acc += ch.len_utf16() as u32;
            }
            Some(_) => {
                let slice = &bytes[start_byte..byte_idx];
                items.push(Item {
                    bytes: slice,
                    hash: hash_bytes(slice, false, false),
                    utf16_len: utf16_acc,
                });
                cur_class = Some(cls);
                start_byte = byte_idx;
                utf16_acc = ch.len_utf16() as u32;
            }
        }
    }

    if start_byte < bytes.len() && utf16_acc > 0 {
        let slice = &bytes[start_byte..];
        items.push(Item {
            bytes: slice,
            hash: hash_bytes(slice, false, false),
            utf16_len: utf16_acc,
        });
    }

    items
}

#[no_mangle]
pub extern "C" fn compute_intraline(
    left_ptr: *const u8,
    left_len: usize,
    right_ptr: *const u8,
    right_len: usize,
    char_mode: u32,
) -> usize {
    let left_bytes = if left_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(left_ptr, left_len) }
    };
    let right_bytes = if right_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(right_ptr, right_len) }
    };

    let is_char = char_mode != 0;
    let left_items = tokenize_intraline(left_bytes, is_char);
    let right_items = tokenize_intraline(right_bytes, is_char);

    let mut ops: Vec<(u32, u32)> = Vec::with_capacity(32);
    myers_diff(&left_items, &right_items, false, false, &mut ops);

    OUTPUT_BUF.with(|buf_cell| {
        let mut out = buf_cell.borrow_mut();
        out.clear();
        out.reserve(ops.len() * 2);
        for (kind, utf16_count) in ops {
            out.push(kind);
            out.push(utf16_count);
        }
        out.len()
    })
}
