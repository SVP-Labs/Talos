//! Lint levels lowered every way a project can lower them.
#![allow(unsafe_code)]

/// Reads a number, panicking on anything else.
///
/// # Panics
///
/// When `text` isn't a number.
pub fn number(text: &str) -> u32 {
    text.parse::<u32>().unwrap()
}

/// Reads memory it was handed.
#[must_use]
pub fn read(value: &u32) -> u32 {
    let pointer: *const u32 = value;
    // SAFETY: the pointer comes from a reference.
    unsafe { *pointer }
}
